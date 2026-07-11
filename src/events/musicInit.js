import { Events } from 'discord.js';
import { logger, startupLog } from '../utils/logger.js';
import { initializePlayer } from '../services/musicService.js';

export default {
    name: Events.ClientReady,
    once: true,
    async execute(client) {
        try {
            await initializePlayer(client);
            startupLog('✅ Music player initialized');
        } catch (error) {
            logger.error('[Music] Failed to initialize player:', error);
        }
    },
};
