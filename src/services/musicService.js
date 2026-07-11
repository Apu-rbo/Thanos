import { Player } from 'discord-player';
import { DefaultExtractors } from '@discord-player/extractor';
import { logger } from '../utils/logger.js';

let playerInstance = null;

/**
 * Initialize the discord-player singleton. Call once on bot ready.
 */
export async function initializePlayer(client) {
    if (playerInstance) return playerInstance;

    playerInstance = new Player(client, {
        skipFFmpeg: false,
    });

    try {
        await playerInstance.extractors.loadMulti(DefaultExtractors);
        logger.info('[Music] Extractors loaded (YouTube, SoundCloud, Spotify metadata, Vimeo, Attachment).');
    } catch (err) {
        logger.error('[Music] Failed to load extractors:', err);
    }

    // Global event logging — helps debugging without crashing the bot
    playerInstance.events.on('error', (queue, error) => {
        logger.error(`[Music] Queue error in guild ${queue.guild.id}:`, error);
    });

    playerInstance.events.on('playerError', (queue, error) => {
        logger.error(`[Music] Player error in guild ${queue.guild.id}:`, error);
    });

    playerInstance.events.on('playerStart', (queue, track) => {
        const channel = queue.metadata?.channel;
        if (channel?.isTextBased()) {
            channel.send({
                embeds: [{
                    title: '🎵 Now Playing',
                    description: `**[${track.title}](${track.url})**\nRequested by ${track.requestedBy}`,
                    thumbnail: { url: track.thumbnail },
                    color: 0x5865F2,
                }],
            }).catch(() => null);
        }
    });

    playerInstance.events.on('emptyQueue', (queue) => {
        const channel = queue.metadata?.channel;
        if (channel?.isTextBased()) {
            channel.send('📭 Queue finished — leaving voice channel.').catch(() => null);
        }
    });

    return playerInstance;
}

export function getPlayer() {
    if (!playerInstance) {
        throw new Error('Player not initialized. Call initializePlayer(client) first.');
    }
    return playerInstance;
}
