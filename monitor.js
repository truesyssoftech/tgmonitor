require("dotenv").config();

const axios = require("axios");
const {
    TelegramClient
} = require("telegram");

const {
    StringSession
} = require("telegram/sessions");

const {
    NewMessage
} = require("telegram/events");


// ============================================================
// CONFIGURATION
// ============================================================

const API_ID = Number(process.env.TELEGRAM_API_ID);
const API_HASH = process.env.TELEGRAM_API_HASH;

const TELEGRAM_SESSION = process.env.TELEGRAM_SESSION;

const TELEGRAM_CHANNEL =
    process.env.TELEGRAM_CHANNEL || "ipo_Alarm";

const WEBHOOK_URL = process.env.WEBHOOK_URL;

const WEBHOOK_SECRET =
    process.env.WEBHOOK_SECRET || "";

const HEARTBEAT_INTERVAL =
    Number(process.env.HEARTBEAT_INTERVAL_MS) ||
    60 * 1000;

const WEBHOOK_TIMEOUT =
    Number(process.env.WEBHOOK_TIMEOUT_MS) ||
    15000;

const WEBHOOK_RETRIES =
    Number(process.env.WEBHOOK_RETRIES) || 3;


// ============================================================
// VALIDATION
// ============================================================

function validateEnvironment() {

    const required = [
        "TELEGRAM_API_ID",
        "TELEGRAM_API_HASH",
        "TELEGRAM_SESSION",
        "WEBHOOK_URL"
    ];

    const missing = required.filter(
        key => !process.env[key]
    );

    if (missing.length > 0) {

        console.error(
            "Missing environment variables:",
            missing.join(", ")
        );

        process.exit(1);
    }

    if (!Number.isInteger(API_ID) || API_ID <= 0) {

        console.error(
            "TELEGRAM_API_ID is invalid."
        );

        process.exit(1);
    }

    try {

        new URL(WEBHOOK_URL);

    } catch {

        console.error(
            "WEBHOOK_URL is invalid."
        );

        process.exit(1);
    }
}


// ============================================================
// TELEGRAM CLIENT
// ============================================================

const session = new StringSession(
    TELEGRAM_SESSION
);

const client = new TelegramClient(
    session,
    API_ID,
    API_HASH,
    {
        connectionRetries: 10,

        // Keep Telegram connection reasonably active.
        autoReconnect: true,

        // Optional logging level.
        baseLogger: undefined
    }
);


// ============================================================
// RUNTIME STATE
// ============================================================

let channelEntity = null;

let channelId = null;

let isShuttingDown = false;

let heartbeatTimer = null;

let lastMessageId = null;


// Keep recently processed message IDs.
// This protects against duplicate processing after reconnects.
const processedMessages = new Map();

const PROCESSED_MESSAGE_TTL =
    10 * 60 * 1000; // 10 minutes


// ============================================================
// LOGGING
// ============================================================

function log(...args) {

    console.log(
        `[${new Date().toISOString()}]`,
        ...args
    );
}


function error(...args) {

    console.error(
        `[${new Date().toISOString()}]`,
        ...args
    );
}


// ============================================================
// MESSAGE DEDUPLICATION
// ============================================================

function getMessageKey(message) {

    return `${channelId}:${message.id}`;
}


function alreadyProcessed(message) {

    const key = getMessageKey(message);

    if (processedMessages.has(key)) {

        return true;
    }

    processedMessages.set(
        key,
        Date.now()
    );

    return false;
}


function cleanupProcessedMessages() {

    const now = Date.now();

    for (const [
        key,
        timestamp
    ] of processedMessages.entries()) {

        if (
            now - timestamp >
            PROCESSED_MESSAGE_TTL
        ) {

            processedMessages.delete(key);
        }
    }
}


// ============================================================
// MEDIA INFORMATION
// ============================================================

function getMediaInfo(message) {

    if (!message.media) {

        return {
            hasMedia: false,
            type: null
        };
    }

    const media = message.media;

    let type = "unknown";

    if (media.className) {

        type = media.className;
    }

    return {
        hasMedia: true,
        type
    };
}


// ============================================================
// TELEGRAM MESSAGE URL
// ============================================================

function buildMessageUrl(
    channel,
    messageId
) {

    if (!channel) {

        return null;
    }

    if (channel.username) {

        return `https://t.me/${channel.username}/${messageId}`;
    }

    return null;
}


// ============================================================
// WEBHOOK REQUEST
// ============================================================

async function sendWebhook(
    payload
) {

    let lastError = null;

    for (
        let attempt = 1;
        attempt <= WEBHOOK_RETRIES;
        attempt++
    ) {

        try {

            log(
                `Webhook attempt ${attempt}/${WEBHOOK_RETRIES}`
            );

            const headers = {
                "Content-Type":
                    "application/json",

                "User-Agent":
                    "Telegram-MTProto-Monitor/1.0",

                "X-Telegram-Monitor":
                    "ipo-alarm"
            };


            if (WEBHOOK_SECRET) {

                headers[
                    "X-Webhook-Secret"
                ] = WEBHOOK_SECRET;
            }


            const response =
                await axios.post(
                    WEBHOOK_URL,
                    payload,
                    {
                        headers,

                        timeout:
                            WEBHOOK_TIMEOUT,

                        validateStatus:
                            () => true
                    }
                );


            if (
                response.status >= 200 &&
                response.status < 300
            ) {

                log(
                    `Webhook delivered successfully. HTTP ${response.status}`
                );

                return true;
            }


            lastError = new Error(
                `Webhook returned HTTP ${response.status}`
            );

            error(
                lastError.message
            );

        } catch (err) {

            lastError = err;

            error(
                "Webhook request failed:",
                err.message
            );
        }


        if (
            attempt <
            WEBHOOK_RETRIES
        ) {

            const delay =
                Math.pow(2, attempt) *
                1000;

            log(
                `Retrying webhook in ${delay}ms...`
            );

            await sleep(delay);
        }
    }


    error(
        "Webhook delivery failed after all retries:",
        lastError?.message
    );

    return false;
}


// ============================================================
// SLEEP
// ============================================================

function sleep(ms) {

    return new Promise(
        resolve =>
            setTimeout(resolve, ms)
    );
}


// ============================================================
// PROCESS TELEGRAM MESSAGE
// ============================================================

async function processMessage(
    message
) {

    if (!message) {

        return;
    }


    // --------------------------------------------------------
    // Ignore service messages where possible.
    // --------------------------------------------------------

    if (
        message.action
    ) {

        log(
            `Ignoring Telegram service message ${message.id}`
        );

        return;
    }


    // --------------------------------------------------------
    // Duplicate protection
    // --------------------------------------------------------

    if (
        alreadyProcessed(message)
    ) {

        log(
            `Duplicate message ignored: ${message.id}`
        );

        return;
    }


    lastMessageId =
        message.id;


    // --------------------------------------------------------
    // Extract message data
    // --------------------------------------------------------

    const text =
        message.text ||
        message.message ||
        "";


    const media =
        getMediaInfo(message);


    const messageUrl =
        buildMessageUrl(
            channelEntity,
            message.id
        );


    const payload = {

        event: "telegram.channel_post",

        source: "telegram",

        receivedAt:
            new Date().toISOString(),


        channel: {

            id:
                channelEntity?.id
                    ?.toString() ||
                null,

            title:
                channelEntity?.title ||
                null,

            username:
                channelEntity?.username ||
                null,

            type:
                channelEntity?.className ||
                null
        },


        message: {

            id:
                message.id,

            text,

            date:
                message.date
                    ? new Date(
                        message.date
                    ).toISOString()
                    : null,

            url:
                messageUrl,

            hasMedia:
                media.hasMedia,

            mediaType:
                media.type
        }
    };


    // --------------------------------------------------------
    // Log
    // --------------------------------------------------------

    log(
        "================================================"
    );

    log(
        "NEW TELEGRAM MESSAGE"
    );

    log(
        `Channel: ${channelEntity?.title}`
    );

    log(
        `Message ID: ${message.id}`
    );

    log(
        `Media: ${media.hasMedia ? media.type : "none"}`
    );

    log(
        `URL: ${messageUrl || "N/A"}`
    );

    log(
        `Text: ${text.substring(0, 500)}`
    );

    log(
        "================================================"
    );


    // --------------------------------------------------------
    // Send webhook
    // --------------------------------------------------------

    const delivered =
        await sendWebhook(
            payload
        );


    if (!delivered) {

        error(
            `Webhook delivery failed for Telegram message ${message.id}`
        );

        /*
         * Important:
         *
         * We don't remove the message from the
         * processed map here.
         *
         * This prevents Telegram reconnects from
         * generating duplicate webhook calls.
         *
         * If you need guaranteed delivery,
         * use a persistent queue/database.
         */
    }
}


// ============================================================
// TELEGRAM CONNECTION
// ============================================================

async function connectTelegram() {

    log(
        "Connecting to Telegram..."
    );

    await client.connect();


    const authorized =
        await client.checkAuthorization();


    if (!authorized) {

        throw new Error(
            "Telegram session is not authorized."
        );
    }


    log(
        "Telegram authorization confirmed."
    );


    // --------------------------------------------------------
    // Resolve channel
    // --------------------------------------------------------

    channelEntity =
        await client.getEntity(
            TELEGRAM_CHANNEL
        );


    channelId =
        channelEntity.id?.toString();


    log(
        "================================================"
    );

    log(
        "Telegram channel resolved"
    );

    log(
        `Title: ${channelEntity.title}`
    );

    log(
        `Username: @${channelEntity.username || "N/A"}`
    );

    log(
        `ID: ${channelId}`
    );

    log(
        `Type: ${channelEntity.className}`
    );

    log(
        "================================================"
    );
}


// ============================================================
// REGISTER TELEGRAM EVENT LISTENER
// ============================================================

function registerMessageListener() {

    client.addEventHandler(

        async (event) => {

            try {

                await processMessage(
                    event.message
                );

            } catch (err) {

                error(
                    "Error processing Telegram message:",
                    err
                );
            }

        },

        new NewMessage({
            chats: [
                TELEGRAM_CHANNEL
            ]
        })
    );


    log(
        `Listening for new messages from ${TELEGRAM_CHANNEL}`
    );
}


// ============================================================
// HEARTBEAT
// ============================================================

function startHeartbeat() {

    heartbeatTimer =
        setInterval(
            async () => {

                if (isShuttingDown) {

                    return;
                }


                cleanupProcessedMessages();


                try {

                    const authorized =
                        await client.checkAuthorization();


                    log(
                        `[HEARTBEAT] Telegram authorized=${authorized} | ` +
                        `channel=${TELEGRAM_CHANNEL} | ` +
                        `lastMessageId=${lastMessageId ?? "none"} | ` +
                        `processed=${processedMessages.size}`
                    );


                    if (!authorized) {

                        error(
                            "[HEARTBEAT] Telegram authorization lost."
                        );

                        await reconnectTelegram();
                    }

                } catch (err) {

                    error(
                        "[HEARTBEAT] Telegram connection check failed:",
                        err.message
                    );

                    await reconnectTelegram();
                }

            },

            HEARTBEAT_INTERVAL
        );


    log(
        `Heartbeat started: every ${HEARTBEAT_INTERVAL / 1000}s`
    );
}


// ============================================================
// RECONNECT
// ============================================================

let reconnectInProgress = false;

async function reconnectTelegram() {

    if (reconnectInProgress) {

        log(
            "Reconnect already in progress."
        );

        return;
    }


    reconnectInProgress = true;


    try {

        log(
            "Starting Telegram reconnect..."
        );


        try {

            await client.disconnect();

        } catch (err) {

            error(
                "Disconnect during reconnect failed:",
                err.message
            );
        }


        await sleep(3000);


        await connectTelegram();


        log(
            "Telegram reconnect successful."
        );

    } catch (err) {

        error(
            "Telegram reconnect failed:",
            err.message
        );

    } finally {

        reconnectInProgress = false;
    }
}


// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

async function shutdown(
    signal
) {

    if (isShuttingDown) {

        return;
    }


    isShuttingDown = true;


    log(
        `Received ${signal}. Shutting down...`
    );


    if (heartbeatTimer) {

        clearInterval(
            heartbeatTimer
        );
    }


    try {

        await client.disconnect();

        log(
            "Telegram disconnected."
        );

    } catch (err) {

        error(
            "Telegram disconnect error:",
            err.message
        );
    }


    log(
        "Shutdown complete."
    );


    process.exit(0);
}


process.on(
    "SIGTERM",
    () => shutdown("SIGTERM")
);

process.on(
    "SIGINT",
    () => shutdown("SIGINT")
);


// ============================================================
// UNHANDLED ERRORS
// ============================================================

process.on(
    "unhandledRejection",
    (reason) => {

        error(
            "Unhandled promise rejection:",
            reason
        );
    }
);


process.on(
    "uncaughtException",
    (err) => {

        error(
            "Uncaught exception:",
            err
        );

        /*
         * Do not immediately process.exit().
         *
         * Render can restart the worker if it actually
         * crashes, but keeping the process alive here
         * gives us a chance to recover from transient
         * errors.
         */
    }
);


// ============================================================
// MAIN
// ============================================================

async function main() {

    validateEnvironment();


    log(
        "================================================"
    );

    log(
        "Telegram IPO Alarm Monitor"
    );

    log(
        "Starting..."
    );

    log(
        `Channel: ${TELEGRAM_CHANNEL}`
    );

    log(
        `Webhook: ${WEBHOOK_URL}`
    );

    log(
        "================================================"
    );


    await connectTelegram();


    registerMessageListener();


    startHeartbeat();


    log(
        "Telegram monitor is now RUNNING."
    );

    log(
        "Waiting for new channel posts..."
    );
}


// ============================================================
// START
// ============================================================

main()
    .catch(async (err) => {

        error(
            "FATAL STARTUP ERROR:",
            err
        );

        /*
         * Exit on startup failure.
         *
         * Render will restart the worker according
         * to the service's restart behavior.
         */

        process.exit(1);
    });
