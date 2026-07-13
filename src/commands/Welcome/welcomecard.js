import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { createEmbed, successEmbed, errorEmbed } from '../../utils/embeds.js';
import { handleInteractionError } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';
import { getConfigValue, setConfigValue } from '../../services/guildConfig.js';
import { generateWelcomeCard } from '../../services/welcomeCardService.js';

const CONFIG_KEY = 'welcomeCard';
const DEFAULTS = {
    enabled: false,
    channelId: null,
    backgroundUrl: null,
    accentColor: '#ec4899',
};

async function getWelcomeCardConfig(client, guildId) {
    const stored = await getConfigValue(client, guildId, CONFIG_KEY, null);
    return { ...DEFAULTS, ...(stored ?? {}) };
}

async function saveWelcomeCardConfig(client, guildId, config) {
    return setConfigValue(client, guildId, CONFIG_KEY, config);
}

export default {
    data: new SlashCommandBuilder()
        .setName('welcomecard')
        .setDescription('Configure the image-based welcome card')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)

        .addSubcommand(sub =>
            sub.setName('setup')
                .setDescription('Enable/disable and set the channel for welcome cards')
                .addBooleanOption(o => o.setName('enabled').setDescription('Turn welcome cards on or off').setRequired(true))
                .addChannelOption(o => o.setName('channel').setDescription('Channel to post welcome cards in').setRequired(false))
        )

        .addSubcommand(sub =>
            sub.setName('background')
                .setDescription('Set a custom background image for the card')
                .addStringOption(o => o.setName('url').setDescription('Direct image URL (png/jpg). Leave blank to reset to default.').setRequired(false))
        )

        .addSubcommand(sub =>
            sub.setName('color')
                .setDescription('Set the accent color for the avatar ring and badge')
                .addStringOption(o => o.setName('hex').setDescription('Hex color, e.g. #ec4899').setRequired(true))
        )

        .addSubcommand(sub =>
            sub.setName('test')
                .setDescription('Preview the welcome card using your own account')
        )

        .addSubcommand(sub =>
            sub.setName('status')
                .setDescription('View current welcome card configuration')
        ),

    category: 'welcome',

    async execute(interaction, guildConfig, client) {
        const sub = interaction.options.getSubcommand();
        const guildId = interaction.guild.id;

        try {
            if (sub === 'setup') {
                const enabled = interaction.options.getBoolean('enabled');
                const channel = interaction.options.getChannel('channel');

                const config = await getWelcomeCardConfig(client, guildId);
                config.enabled = enabled;
                if (channel) config.channelId = channel.id;

                if (enabled && !config.channelId) {
                    return InteractionHelper.universalReply(interaction, {
                        embeds: [errorEmbed('Channel Required', 'Specify a channel the first time you enable this: `/welcomecard setup enabled:true channel:#welcome`')],
                        ephemeral: true,
                    });
                }

                await saveWelcomeCardConfig(client, guildId, config);

                return InteractionHelper.universalReply(interaction, {
                    embeds: [successEmbed(
                        enabled ? '✅ Welcome Cards Enabled' : '⏸️ Welcome Cards Disabled',
                        enabled
                            ? `New members will get a welcome card posted in <#${config.channelId}>.`
                            : 'Welcome cards have been turned off.'
                    )],
                });
            }

            if (sub === 'background') {
                const url = interaction.options.getString('url');
                const config = await getWelcomeCardConfig(client, guildId);
                config.backgroundUrl = url || null;
                await saveWelcomeCardConfig(client, guildId, config);

                return InteractionHelper.universalReply(interaction, {
                    embeds: [successEmbed(
                        url ? '✅ Background Set' : '✅ Background Reset',
                        url ? 'Custom background image saved. Run `/welcomecard test` to preview it.' : 'Reverted to the default gradient background.'
                    )],
                });
            }

            if (sub === 'color') {
                const hex = interaction.options.getString('hex');
                if (!/^#([0-9a-f]{6})$/i.test(hex)) {
                    return InteractionHelper.universalReply(interaction, {
                        embeds: [errorEmbed('Invalid Color', 'Use a 6-digit hex color like `#ec4899`.')],
                        ephemeral: true,
                    });
                }

                const config = await getWelcomeCardConfig(client, guildId);
                config.accentColor = hex;
                await saveWelcomeCardConfig(client, guildId, config);

                return InteractionHelper.universalReply(interaction, {
                    embeds: [successEmbed('✅ Accent Color Set', `Accent color set to **${hex}**.`)],
                });
            }

            if (sub === 'test') {
                await InteractionHelper.safeDefer(interaction);

                const config = await getWelcomeCardConfig(client, guildId);
                const memberCount = interaction.guild.memberCount;

                try {
                    const buffer = await generateWelcomeCard({
                        username: interaction.member.displayName,
                        avatarUrl: interaction.user.displayAvatarURL({ extension: 'png', size: 256 }),
                        serverName: interaction.guild.name,
                        memberNumber: memberCount,
                        backgroundUrl: config.backgroundUrl,
                        accentColor: config.accentColor,
                    });

                    return InteractionHelper.safeEditReply(interaction, {
                        content: '🎨 Preview:',
                        files: [{ attachment: buffer, name: 'welcome-preview.png' }],
                    });
                } catch (err) {
                    logger.error('[WelcomeCard] Test generation failed:', err);
                    return InteractionHelper.safeEditReply(interaction, {
                        embeds: [errorEmbed('Generation Failed', `Couldn't generate the card: ${err.message}`)],
                    });
                }
            }

            if (sub === 'status') {
                const config = await getWelcomeCardConfig(client, guildId);

                return InteractionHelper.universalReply(interaction, {
                    embeds: [createEmbed({
                        title: '🖼️ Welcome Card Configuration',
                        color: 'primary',
                        fields: [
                            { name: 'Status', value: config.enabled ? '✅ Enabled' : '⏸️ Disabled', inline: true },
                            { name: 'Channel', value: config.channelId ? `<#${config.channelId}>` : 'Not set', inline: true },
                            { name: 'Accent Color', value: config.accentColor, inline: true },
                            { name: 'Background', value: config.backgroundUrl ? `[Custom Image](${config.backgroundUrl})` : 'Default gradient', inline: false },
                        ],
                    })],
                });
            }
        } catch (error) {
            logger.error('WelcomeCard command error:', error);
            await handleInteractionError(interaction, error, { subtype: 'welcomecard_failed' });
        }
    },
};
