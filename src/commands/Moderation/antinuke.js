import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { createEmbed, successEmbed, errorEmbed } from '../../utils/embeds.js';
import { handleInteractionError } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';
import { getAntiNukeConfig, saveAntiNukeConfig } from '../../services/antiNukeService.js';

export default {
    data: new SlashCommandBuilder()
        .setName('antinuke')
        .setDescription('Configure automated protection against nuke attacks')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

        .addSubcommand(sub =>
            sub.setName('setup')
                .setDescription('Enable or disable AntiNuke')
                .addBooleanOption(o => o.setName('enabled').setDescription('Turn AntiNuke on or off').setRequired(true))
        )

        .addSubcommand(sub =>
            sub.setName('punishment')
                .setDescription('Set what happens to users who trigger AntiNuke')
                .addStringOption(o =>
                    o.setName('action').setDescription('Punishment to apply').setRequired(true)
                        .addChoices(
                            { name: 'Ban', value: 'ban' },
                            { name: 'Kick', value: 'kick' },
                            { name: 'Strip all roles', value: 'strip' },
                        )
                )
        )

        .addSubcommand(sub =>
            sub.setName('threshold')
                .setDescription('Set how many actions trigger a punishment')
                .addStringOption(o =>
                    o.setName('type').setDescription('Which action type to configure').setRequired(true)
                        .addChoices(
                            { name: 'Bans', value: 'banThreshold' },
                            { name: 'Kicks', value: 'kickThreshold' },
                            { name: 'Channel Deletes', value: 'channelDeleteThreshold' },
                            { name: 'Role Deletes', value: 'roleDeleteThreshold' },
                            { name: 'Webhook Creates', value: 'webhookCreateThreshold' },
                        )
                )
                .addIntegerOption(o =>
                    o.setName('count').setDescription('Number of actions within the time window to trigger punishment')
                        .setRequired(true).setMinValue(2).setMaxValue(20)
                )
        )

        .addSubcommand(sub =>
            sub.setName('logchannel')
                .setDescription('Set the channel where AntiNuke actions are logged')
                .addChannelOption(o => o.setName('channel').setDescription('Log channel').setRequired(true))
        )

        .addSubcommand(sub =>
            sub.setName('whitelist')
                .setDescription('Add or remove a trusted user from AntiNuke checks')
                .addUserOption(o => o.setName('user').setDescription('User to whitelist/unwhitelist').setRequired(true))
        )

        .addSubcommand(sub =>
            sub.setName('status')
                .setDescription('View current AntiNuke configuration')
        ),

    category: 'moderation',

    async execute(interaction, guildConfig, client) {
        const sub = interaction.options.getSubcommand();
        const guildId = interaction.guild.id;

        try {
            if (sub === 'setup') {
                const enabled = interaction.options.getBoolean('enabled');
                const config = await getAntiNukeConfig(client, guildId);
                config.enabled = enabled;
                await saveAntiNukeConfig(client, guildId, config);

                return InteractionHelper.universalReply(interaction, {
                    embeds: [successEmbed(
                        enabled ? '✅ AntiNuke Enabled' : '⏸️ AntiNuke Disabled',
                        enabled
                            ? 'Your server is now protected against mass ban/kick/channel-delete/role-delete/webhook-spam attacks.'
                            : 'AntiNuke protection has been turned off.'
                    )],
                });
            }

            if (sub === 'punishment') {
                const action = interaction.options.getString('action');
                const config = await getAntiNukeConfig(client, guildId);
                config.punishment = action;
                await saveAntiNukeConfig(client, guildId, config);

                return InteractionHelper.universalReply(interaction, {
                    embeds: [successEmbed('✅ Punishment Updated', `AntiNuke will now use **${action}** for offenders.`)],
                });
            }

            if (sub === 'threshold') {
                const type  = interaction.options.getString('type');
                const count = interaction.options.getInteger('count');
                const config = await getAntiNukeConfig(client, guildId);
                config[type] = count;
                await saveAntiNukeConfig(client, guildId, config);

                return InteractionHelper.universalReply(interaction, {
                    embeds: [successEmbed('✅ Threshold Updated', `**${type}** is now set to **${count}** within the detection window.`)],
                });
            }

            if (sub === 'logchannel') {
                const channel = interaction.options.getChannel('channel');
                const config = await getAntiNukeConfig(client, guildId);
                config.logChannelId = channel.id;
                await saveAntiNukeConfig(client, guildId, config);

                return InteractionHelper.universalReply(interaction, {
                    embeds: [successEmbed('✅ Log Channel Set', `AntiNuke actions will be logged in ${channel}.`)],
                });
            }

            if (sub === 'whitelist') {
                const user = interaction.options.getUser('user');
                const config = await getAntiNukeConfig(client, guildId);

                const idx = config.whitelistedUserIds.indexOf(user.id);
                if (idx >= 0) {
                    config.whitelistedUserIds.splice(idx, 1);
                    await saveAntiNukeConfig(client, guildId, config);
                    return InteractionHelper.universalReply(interaction, {
                        embeds: [successEmbed('✅ Removed from Whitelist', `${user} is no longer exempt from AntiNuke.`)],
                    });
                } else {
                    config.whitelistedUserIds.push(user.id);
                    await saveAntiNukeConfig(client, guildId, config);
                    return InteractionHelper.universalReply(interaction, {
                        embeds: [successEmbed('✅ Added to Whitelist', `${user} is now exempt from AntiNuke checks.`)],
                    });
                }
            }

            if (sub === 'status') {
                const config = await getAntiNukeConfig(client, guildId);

                return InteractionHelper.universalReply(interaction, {
                    embeds: [createEmbed({
                        title: '🛡️ AntiNuke Configuration',
                        color: 'primary',
                        fields: [
                            { name: 'Status', value: config.enabled ? '✅ Enabled' : '⏸️ Disabled', inline: true },
                            { name: 'Punishment', value: config.punishment, inline: true },
                            { name: 'Window', value: `${config.windowMs / 1000}s`, inline: true },
                            { name: 'Ban Threshold', value: `${config.banThreshold}`, inline: true },
                            { name: 'Kick Threshold', value: `${config.kickThreshold}`, inline: true },
                            { name: 'Channel Delete Threshold', value: `${config.channelDeleteThreshold}`, inline: true },
                            { name: 'Role Delete Threshold', value: `${config.roleDeleteThreshold}`, inline: true },
                            { name: 'Webhook Create Threshold', value: `${config.webhookCreateThreshold}`, inline: true },
                            { name: 'Log Channel', value: config.logChannelId ? `<#${config.logChannelId}>` : 'Not set', inline: true },
                            { name: 'Whitelisted Users', value: config.whitelistedUserIds.length ? config.whitelistedUserIds.map(id => `<@${id}>`).join(', ') : 'None', inline: false },
                        ],
                    })],
                });
            }
        } catch (error) {
            logger.error('AntiNuke command error:', error);
            await handleInteractionError(interaction, error, { subtype: 'antinuke_failed' });
        }
    },
};
