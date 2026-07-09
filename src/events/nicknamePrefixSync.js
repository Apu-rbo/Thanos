import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { getPrefixConfig, syncMemberNickname } from '../services/nicknamePrefixService.js';

export default {
    name: Events.GuildMemberUpdate,
    async execute(oldMember, newMember) {
        try {
            // Only react if roles actually changed
            const oldRoleIds = new Set(oldMember.roles.cache.map(r => r.id));
            const newRoleIds = new Set(newMember.roles.cache.map(r => r.id));

            const rolesChanged =
                oldRoleIds.size !== newRoleIds.size ||
                [...newRoleIds].some(id => !oldRoleIds.has(id));

            if (!rolesChanged) return;
            if (newMember.user.bot) return;

            const config = await getPrefixConfig(newMember.client, newMember.guild.id);
            if (!config.enabled && Object.keys(config.manualPrefixes).length === 0) return;

            await syncMemberNickname(newMember.client, newMember, config);
        } catch (error) {
            logger.error('[NickPrefix] guildMemberUpdate sync error:', error);
        }
    },
};
