import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright-core';

const [positiveRoom, controlRoom, userAgent, proofDirectory] = process.argv.slice(2);

if (!positiveRoom || !controlRoom || !userAgent || !proofDirectory) {
    throw new Error('Expected positive room, control room, user agent, and proof directory');
}

const chromePath = process.env.CHROME_PATH
    ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const receiverName = 'SyntheticReceiver';
const senderName = 'SyntheticIOS';

function writeJson(name, value) {
    fs.writeFileSync(path.join(proofDirectory, name), `${JSON.stringify(value, null, 2)}\n`);
}

function meetingUrl(room) {
    const fragment = [
        'config.prejoinPageEnabled=false',
        'config.startWithAudioMuted=true',
        'config.startWithVideoMuted=true',
        `userInfo.displayName=${encodeURIComponent(JSON.stringify(receiverName))}`
    ].join('&');

    return `https://kmeet.infomaniak.com/${room}#${fragment}`;
}

async function snapshot(page, expectedName) {
    return page.evaluate(name => {
        const state = globalThis.APP?.store?.getState?.();

        if (!state) {
            return {
                app_ready: false,
                href: location.href,
                title: document.title
            };
        }

        const participantState = state['features/base/participants'];
        const remoteValues = participantState?.remote instanceof Map
            ? Array.from(participantState.remote.values())
            : Object.values(participantState?.remote ?? {});
        const participants = remoteValues.map(participant => ({
            id: participant.id,
            name: participant.name ?? participant.displayName ?? '',
            role: participant.role ?? null
        }));
        const expected = remoteValues.find(participant =>
            (participant.name ?? participant.displayName) === name);
        const tracks = (state['features/base/tracks'] ?? [])
            .filter(track => !track.local && (!expected || track.participantId === expected.id))
            .map(track => ({
                participant_id: track.participantId,
                media_type: track.mediaType,
                muted: typeof track.jitsiTrack?.isMuted === 'function'
                    ? track.jitsiTrack.isMuted()
                    : Boolean(track.muted),
                receiving_data: typeof track.jitsiTrack?.isReceivingData === 'function'
                    ? track.jitsiTrack.isReceivingData()
                    : null
            }));
        const conference = state['features/base/conference']?.conference;

        return {
            app_ready: true,
            conference_joined: Boolean(conference?.isJoined?.()),
            participants,
            expected_participant_id: expected?.id ?? null,
            tracks
        };
    }, expectedName);
}

async function ensureReceiverJoined(page, room) {
    await page.goto(meetingUrl(room), { waitUntil: 'domcontentloaded', timeout: 120_000 });

    let current;

    for (let attempt = 0; attempt < 90; attempt += 1) {
        current = await snapshot(page, senderName);

        if (current.conference_joined) {
            return current;
        }

        if (attempt === 5) {
            const browserChoice = page.getByText('From the browser', { exact: true });

            if (await browserChoice.count()) {
                await browserChoice.click();
            }
        }

        if (attempt === 10) {
            const continueButton = page.getByText('OK', { exact: true });

            if (await continueButton.count()) {
                await continueButton.click();
            }
        }

        if (attempt === 20) {
            const nameInput = page.locator('#premeeting-name-input');

            if (await nameInput.count()) {
                await nameInput.fill(receiverName);
                const joinButton = page.locator('[data-testid="prejoin.joinMeeting"]');

                if (await joinButton.count()) {
                    await joinButton.click();
                }
            }
        }

        await page.waitForTimeout(1_000);
    }

    const diagnostics = {
        snapshot: current,
        body_text: (await page.locator('body').innerText()).slice(0, 4_000),
        name_input_count: await page.locator('#premeeting-name-input').count(),
        join_button_count: await page.locator('[data-testid="prejoin.joinMeeting"]').count()
    };

    writeJson(`receiver-not-joined-${room}.json`, diagnostics);
    await page.screenshot({
        path: path.join(proofDirectory, `receiver-not-joined-${room}.png`),
        fullPage: true
    });

    throw new Error(`Receiver did not join room ${room}`);
}

async function waitForSender(page, timeoutSeconds) {
    let current = await snapshot(page, senderName);

    for (let attempt = 0; attempt < timeoutSeconds; attempt += 1) {
        current = await snapshot(page, senderName);

        if (current.expected_participant_id) {
            return current;
        }

        await page.waitForTimeout(1_000);
    }

    return current;
}

const browser = await chromium.launch({
    executablePath: chromePath,
    headless: true,
    args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required'
    ]
});

try {
    const context = await browser.newContext({
        userAgent,
        locale: 'en-US',
        permissions: [ 'microphone', 'camera' ],
        viewport: { width: 1440, height: 1000 }
    });
    const page = await context.newPage();

    page.on('console', message => {
        if (message.type() === 'error') {
            console.error(`browser-console: ${message.text()}`);
        }
    });
    page.on('requestfailed', request => {
        console.error(`request-failed: ${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`);
    });

    const positiveReady = await ensureReceiverJoined(page, positiveRoom);
    writeJson('positive-ready.json', positiveReady);

    const positiveSnapshot = await waitForSender(page, 180);
    const positiveAudio = positiveSnapshot.tracks?.find(track => track.media_type === 'audio');
    const positiveResult = {
        phase: 'positive',
        room: positiveRoom,
        participant_seen: Boolean(positiveSnapshot.expected_participant_id),
        audio_track_seen: Boolean(positiveAudio),
        audio_muted: positiveAudio?.muted ?? null,
        receiving_data: positiveAudio?.receiving_data ?? null,
        snapshot: positiveSnapshot
    };

    await page.screenshot({ path: path.join(proofDirectory, 'positive-receiver.png'), fullPage: true });
    writeJson('positive-result.json', positiveResult);

    const controlReady = await ensureReceiverJoined(page, controlRoom);
    writeJson('control-ready.json', controlReady);

    const controlSnapshot = await waitForSender(page, 45);
    const controlResult = {
        phase: 'control_without_username',
        room: controlRoom,
        participant_seen: Boolean(controlSnapshot.expected_participant_id),
        snapshot: controlSnapshot
    };

    await page.screenshot({ path: path.join(proofDirectory, 'control-receiver.png'), fullPage: true });
    writeJson('control-result.json', controlResult);

    if (!positiveResult.participant_seen || !positiveResult.audio_track_seen || positiveResult.audio_muted !== false) {
        throw new Error('The positive link did not produce an unmuted remote audio track');
    }

    if (controlResult.participant_seen) {
        throw new Error('The control link joined the conference without a username parameter');
    }
} finally {
    await browser.close();
}
