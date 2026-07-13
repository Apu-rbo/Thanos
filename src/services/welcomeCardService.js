import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { getConfigValue } from '../services/guildConfig.js';
import { generateWelcomeCard } from '../services/welcomeCardService.js';

const CONFIG_KEY = 'welcomeCard';

export default {
    name: Events.GuildMemberAdd,
    async execute(member) {
        try {
            const config = await getConfigValue(member.client, member.guild.id, CONFIG_KEY, null);
            if (!config?.enabled || !config.channelId) return;

            const channel = member.guild.channels.cache.get(config.channelId);
            if (!channel?.isTextBased()) return;

            const buffer = await generateWelcomeCard({
                username: member.displayName,
                avatarUrl: member.user.displayAvatarURL({ extension: 'png', size: 256 }),
                serverName: member.guild.name,
                memberNumber: member.guild.memberCount,
                backgroundUrl: config.backgroundUrl,
                accentColor: config.accentColor ?? '#ec4899',
            });

            await channel.send({
                content: `Welcome <@${member.id}> to **${member.guild.name}**!`,
                files: [{ attachment: buffer, name: 'welcome.png' }],
            });
        } catch (error) {
            logger.error('[WelcomeCard] guildMemberAdd handler error:', error);
        }
    },
};
