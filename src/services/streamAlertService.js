import { logger } from '../utils/logger.js';
import { getConfigValue, setConfigValue } from './guildConfig.js';

const CONFIG_KEY = 'streamAlerts';
const DEFAULT_STATE = { streamers: {} };
// streamers: { [`${platform}:${identifier}`]: {
//   platform: 'twitch' | 'youtube',
//   identifier,       // twitch username OR youtube channel ID
//   displayName,
//   channelId,         // Discord channel to post in
//   mentionType: 'everyone' | 'here' | 'role' | 'none',
//   roleId, customMessage, isLive, lastStreamId, addedBy
// } }

// ─────────────────────────────────────────────────────────────────────────────
// Twitch
// ─────────────────────────────────────────────────────────────────────────────

let cachedTwitchToken = null;
let twitchTokenExpiresAt = 0;

async function getTwitchAppAccessToken() {
    if (cachedTwitchToken && Date.now() < twitchTokenExpiresAt - 60_000) return cachedTwitchToken;

    const clientId = process.env.TWITCH_CLIENT_ID;
    const clientSecret = process.env.TWITCH_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        throw new Error('Twitch API credentials are not configured (TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET).');
    }

    const res = await fetch(
        `https://id.twitch.tv/oauth2/token?client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`,
        { method: 'POST' }
    );
    const data = await res.json();
    if (!res.ok) {
        throw new Error(`Twitch auth failed: ${data.message || res.status}`);
    }

    cachedTwitchToken = data.access_token;
    twitchTokenExpiresAt = Date.now() + data.expires_in * 1000;
    return cachedTwitchToken;
}

async function twitchFetch(path) {
    const token = await getTwitchAppAccessToken();
    const res = await fetch(`https://api.twitch.tv/helix${path}`, {
        headers: {
            'Client-Id': process.env.TWITCH_CLIENT_ID,
            Authorization: `Bearer ${token}`,
        },
    });
    if (!res.ok) {
        throw new Error(`Twitch API returned ${res.status}`);
    }
    return res.json();
}

/** Look up a Twitch user to confirm the username exists before tracking it. */
export async function getTwitchUser(username) {
    const data = await twitchFetch(`/users?login=${encodeURIComponent(username.toLowerCase())}`);
    return data.data?.[0] ?? null;
}

/** Returns stream info if the user is currently live, otherwise null. */
export async function getTwitchStreamInfo(username) {
    const data = await twitchFetch(`/streams?user_login=${encodeURIComponent(username.toLowerCase())}`);
    return data.data?.[0] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// YouTube
//
// IMPORTANT QUOTA NOTE: the only official way to detect if a channel is
// currently live is the `search` endpoint, which costs 100 of your 10,000
// free daily quota units PER CALL. That caps you at ~100 checks/day total
// across every tracked YouTube channel combined. This is why YouTube alerts
// run on a much longer interval (default 15 min) than Twitch (3 min) — it's
// a hard platform limit, not a choice made for this bot specifically.
// ─────────────────────────────────────────────────────────────────────────────

async function youtubeFetch(path) {
    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) {
        throw new Error('YouTube API key is not configured (YOUTUBE_API_KEY).');
    }
    const separator = path.includes('?') ? '&' : '?';
    const res = await fetch(`https://www.googleapis.com/youtube/v3${path}${separator}key=${apiKey}`);
    const data = await res.json();
    if (!res.ok) {
        throw new Error(`YouTube API error: ${data.error?.message || res.status}`);
    }
    return data;
}

/**
 * Resolve a handle (@name), legacy username, or raw channel ID into a
 * confirmed channel ID + display name. Cheap (1 quota unit) — safe to
 * call anytime, unlike the live-check below.
 */
export async function resolveYoutubeChannel(input) {
    const trimmed = input.trim();

    // Already looks like a channel ID (starts with UC, 24 chars)
    if (/^UC[\w-]{22}$/.test(trimmed)) {
        const data = await youtubeFetch(`/channels?part=snippet&id=${trimmed}`);
        const channel = data.items?.[0];
        return channel ? { channelId: channel.id, displayName: channel.snippet.title } : null;
    }

    const handle = trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
    const byHandle = await youtubeFetch(`/channels?part=snippet&forHandle=${encodeURIComponent(handle)}`);
    if (byHandle.items?.[0]) {
        const channel = byHandle.items[0];
        return { channelId: channel.id, displayName: channel.snippet.title };
    }

    return null;
}

/** Returns live video info if the channel is currently live, otherwise null. Costs 100 quota units. */
export async function getYoutubeLiveInfo(channelId) {
    const data = await youtubeFetch(
        `/search?part=snippet&channelId=${channelId}&eventType=live&type=video`
    );
    const item = data.items?.[0];
    if (!item) return null;

    return {
        videoId: item.id.videoId,
        title: item.snippet.title,
        channelTitle: item.snippet.channelTitle,
        thumbnail: item.snippet.thumbnails?.high?.url ?? item.snippet.thumbnails?.default?.url,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared config storage
// ─────────────────────────────────────────────────────────────────────────────

export async function getStreamAlertConfig(client, guildId) {
    const stored = await getConfigValue(client, guildId, CONFIG_KEY, null);
    return { ...DEFAULT_STATE, ...(stored ?? {}), streamers: { ...(stored?.streamers ?? {}) } };
}

export async function saveStreamAlertConfig(client, guildId, config) {
    return setConfigValue(client, guildId, CONFIG_KEY, config);
}

export function streamerKey(platform, identifier) {
    return `${platform}:${identifier.toLowerCase()}`;
}

export function buildMentionString(mentionType, roleId) {
    if (mentionType === 'everyone') return '@everyone';
    if (mentionType === 'here') return '@here';
    if (mentionType === 'role' && roleId) return `<@&${roleId}>`;
    return '';
}

function formatMessage(template, vars) {
    if (!template) return null;
    let result = template;
    for (const [key, value] of Object.entries(vars)) {
        result = result.replaceAll(`{${key}}`, value ?? '');
    }
    return result;
}

async function sendGoLiveAlert(guild, data, embedData) {
    const channel = guild.channels.cache.get(data.channelId);
    if (!channel?.isTextBased()) return false;

    const mention = buildMentionString(data.mentionType, data.roleId);
    const customContent = formatMessage(data.customMessage, {
        streamer: embedData.streamerName,
        title: embedData.title,
        game: embedData.subtitle,
        url: embedData.url,
    });

    await channel.send({
        content: [mention, customContent].filter(Boolean).join('\n') || undefined,
        allowedMentions: { parse: ['everyone', 'roles'] },
        embeds: [{
            title: embedData.headline,
            description: `**${embedData.title}**${embedData.subtitle ? `\n${embedData.subtitle}` : ''}`,
            url: embedData.url,
            color: embedData.color,
            image: embedData.thumbnail ? { url: embedData.thumbnail } : undefined,
            timestamp: new Date().toISOString(),
        }],
    }).catch(err => {
        logger.warn(`[StreamAlert] Failed to send alert:`, err.message);
        return false;
    });

    return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sweeps — called by cron, one per platform since they run on different
// intervals (Twitch is cheap/frequent, YouTube is quota-limited/infrequent).
// ─────────────────────────────────────────────────────────────────────────────

export async function checkAllTwitchStreamers(client) {
    return runSweep(client, 'twitch', async (data) => {
        const stream = await getTwitchStreamInfo(data.identifier);
        return stream ? {
            isLive: true,
            streamId: stream.id,
            embed: {
                headline: `🔴 ${stream.user_name} is now live on Twitch!`,
                title: stream.title || 'Live now!',
                subtitle: stream.game_name ? `Playing **${stream.game_name}**` : '',
                url: `https://twitch.tv/${data.identifier}`,
                color: 0x9146FF,
                thumbnail: stream.thumbnail_url?.replace('{width}', '640')?.replace('{height}', '360'),
                streamerName: stream.user_name,
            },
        } : { isLive: false };
    });
}

export async function checkAllYoutubeStreamers(client) {
    return runSweep(client, 'youtube', async (data) => {
        const live = await getYoutubeLiveInfo(data.identifier);
        return live ? {
            isLive: true,
            streamId: live.videoId,
            embed: {
                headline: `🔴 ${live.channelTitle} is now live on YouTube!`,
                title: live.title,
                subtitle: '',
                url: `https://youtube.com/watch?v=${live.videoId}`,
                color: 0xFF0000,
                thumbnail: live.thumbnail,
                streamerName: live.channelTitle,
            },
        } : { isLive: false };
    });
}

async function runSweep(client, platform, checkFn) {
    let checked = 0, announced = 0, errors = 0;

    for (const [guildId] of client.guilds.cache) {
        let config;
        try {
            config = await getStreamAlertConfig(client, guildId);
        } catch (err) {
            logger.warn(`[StreamAlert] Failed to load config for guild ${guildId}:`, err.message);
            continue;
        }

        const entries = Object.entries(config.streamers).filter(([, data]) => data.platform === platform);
        if (entries.length === 0) continue;

        const guild = client.guilds.cache.get(guildId);
        if (!guild) continue;

        let configChanged = false;

        for (const [key, data] of entries) {
            checked++;
            try {
                const result = await checkFn(data);
                const wentLive = result.isLive && !data.isLive;

                if (wentLive) {
                    const sent = await sendGoLiveAlert(guild, data, result.embed);
                    if (sent) announced++;
                }

                if (data.isLive !== result.isLive) {
                    data.isLive = result.isLive;
                    data.lastStreamId = result.streamId ?? data.lastStreamId ?? null;
                    configChanged = true;
                }
            } catch (err) {
                errors++;
                logger.warn(`[StreamAlert] Error checking ${key} in guild ${guildId}:`, err.message);
            }

            await new Promise(r => setTimeout(r, 300));
        }

        if (configChanged) {
            await saveStreamAlertConfig(client, guildId, config).catch(() => {});
        }
    }

    if (checked > 0) {
        logger.debug(`[StreamAlert:${platform}] Sweep complete: checked ${checked}, announced ${announced}, errors ${errors}`);
    }

    return { checked, announced, errors };
}
