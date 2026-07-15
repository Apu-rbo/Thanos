import { Events } from 'discord.js';
import cron from 'node-cron';
import { logger } from '../utils/logger.js';
import { checkAllTrackedAccounts } from '../services/valorantService.js';

export default {
    name: Events.ClientReady,
    once: true,
    async execute(client) {
        logger.info('[Valorant] Tracked-account sweep scheduler started — runs every 15 minutes.');

        cron.schedule('*/15 * * * *', async () => {
            try {
                logger.info('[Valorant] Running scheduled account sweep...');
                const summary = await checkAllTrackedAccounts(client);
                logger.info(`[Valorant] Sweep done: checked ${summary.checked}, updated ${summary.updated}, roles assigned ${summary.rolesAssigned}, errors ${summary.errors}`);
            } catch (error) {
                logger.error('[Valorant] Scheduled sweep error:', error);
            }
        });
    },
};
