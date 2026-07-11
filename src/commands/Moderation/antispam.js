import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { createEmbed, successEmbed, errorEmbed } from '../../utils/embeds.js';
import { handleInteractionError } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';
import { getAntiSpamConfig, saveAntiSpamConfig } from '../../services/antiSpamService.js';

export default {
    data: new SlashCommandBuilder()
        .setName('antispam')
        .setDescription('Configure automated spam protection')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

        .addSubcommand(sub =>
            sub.setName('setup')
                .setDescription('Enable or disable AntiSpam')
                .addBooleanOption(o => o.setName('enabled').setDescription('Turn AntiSpam on or off').setRequired(true))
        )

        .addSubcommand(sub =>
            sub.setName('threshold')
                .setDescription('Set how many messages trigger spam detection')
                .addIntegerOption(o => o.setName('messages').setDescription('Number of messages').setRequired(true).setMinValue(2).setMaxValue(20))
                .addIntegerOption(o => o.setName('seconds').setDescription('Time window in seconds').setRequired(true).setMinValue(1).setMaxValue(60))
        )

        .addSubcommand(sub =>
            sub.setName('punishment')
                .setDescription('Set what happens to spammers')
                .addStringOption(o =>
                    o.setName('action').setDescription('Punishment to apply').setRequired(true)
                        .addChoices(
                            { name: 'Timeout', value: 'timeout' },
                            { name: 'Kick', value: 'kick' },
                            { name: 'Ban', value: 'ban' },
                        )
                )
        )

        .addSubcommand(sub =>
            sub.setName('timeoutduration')
                .setDescription('Set timeout length in minutes (only used if punishment is timeout)')
                .addIntegerOption(o => o.setName('minutes').setDescription('Timeout duration in minutes').setRequired(true).setMinValue(1).setMaxValue(1440))
        )

        .addSubcommand(sub =>
            sub.setName('logchannel')
                .setDescription('Set the channel where AntiSpam actions are logged')
                .addChannelOption(o => o.setName('channel').setDescription('Log channel').setRequired(true))
        )

        .addSubcommand(sub =>
            sub.setName('ignorechannel')
                .setDescription('Add or remove a channel from AntiSpam monitoring')
                .addChannelOption(o => o.setName('channel').setDescription('Channel to ignore/unignore').setRequired(true))
        )

        .addSubcommand(sub =>
            sub.setName('ignorerole')
                .setDescription('Add or remove a role from AntiSpam monitoring')
                .addRoleOption(o => o.setName('role').setDescription('Role to ignore/unignore').setRequired(true))
        )

        .addSubcommand(sub =>
            sub.setName('status')
                .setDescription('View current AntiSpam configuration')
        ),

    category: 'moderation',

    async execute(interaction, guildConfig, client) {
        const sub = interaction.options.getSubcommand();
        const guildId = interaction.guild.id;

        try {
            if (sub === 'setup') {
                const enabled = interaction.options.getBoolean('enabled');
                const config = await getAntiSpamConfig(client, guildId);
                config.enabled = enabled;
                await saveAntiSpamConfig(client, guildId, config);

                return InteractionHelper.universalReply(interaction, {
                    embeds: [successEmbed(
                        enabled ? '✅ AntiSpam Enabled' : '⏸️ AntiSpam Disabled',
                        enabled
                            ? 'Message spam will now be automatically detected and punished.'
                            : 'AntiSpam protection has been turned off.'
                    )],
                });
            }

            if (sub === 'threshold') {
                const messages = interaction.options.getInteger('messages');
                const seconds  = interaction.options.getInteger('seconds');
                const config = await getAntiSpamConfig(client, guildId);
                config.maxMessages = messages;
                config.windowMs    = seconds * 1000;
                await saveAntiSpamConfig(client, guildId, config);

                return InteractionHelper.universalReply(interaction, {
                    embeds: [successEmbed('✅ Threshold Updated', `Spam is now detected at **${messages} messages** within **${seconds}s**.`)],
                });
            }

            if (sub === 'punishment') {
                const action = interaction.options.getString('action');
                const config = await getAntiSpamConfig(client, guildId);
                config.punishment = action;
                await saveAntiSpamConfig(client, guildId, config);

                return InteractionHelper.universalReply(interaction, {
                    embeds: [successEmbed('✅ Punishment Updated', `AntiSpam will now use **${action}** for spammers.`)],
                });
            }

            if (sub === 'timeoutduration') {
                const minutes = interaction.options.getInteger('minutes');
                const config = await getAntiSpamConfig(client, guildId);
                config.timeoutDurationMs = minutes * 60000;
                await saveAntiSpamConfig(client, guildId, config);

                return InteractionHelper.universalReply(interaction, {
                    embeds: [successEmbed('✅ Timeout Duration Updated', `Spammers will now be timed out for **${minutes} minute(s)**.`)],
                });
            }

            if (sub === 'logchannel') {
                const channel = interaction.options.getChannel('channel');
                const config = await getAntiSpamConfig(client, guildId);
                config.logChannelId = channel.id;
                await saveAntiSpamConfig(client, guildId, config);

                return InteractionHelper.universalReply(interaction, {
                    embeds: [successEmbed('✅ Log Channel Set', `AntiSpam actions will be logged in ${channel}.`)],
                });
            }

            if (sub === 'ignorechannel') {
                const channel = interaction.options.getChannel('channel');
                const config = await getAntiSpamConfig(client, guildId);

                const idx = config.ignoredChannelIds.indexOf(channel.id);
                if (idx >= 0) {
                    config.ignoredChannelIds.splice(idx, 1);
                    await saveAntiSpamConfig(client, guildId, config);
                    return InteractionHelper.universalReply(interaction, {
                        embeds: [successEmbed('✅ Channel Now Monitored', `${channel} will now be monitored for spam again.`)],
                    });
                } else {
                    config.ignoredChannelIds.push(channel.id);
                    await saveAntiSpamConfig(client, guildId, config);
                    return InteractionHelper.universalReply(interaction, {
                        embeds: [successEmbed('✅ Channel Ignored', `${channel} is now exempt from AntiSpam checks.`)],
                    });
                }
            }

            if (sub === 'ignorerole') {
                const role = interaction.options.getRole('role');
                const config = await getAntiSpamConfig(client, guildId);

                const idx = config.ignoredRoleIds.indexOf(role.id);
                if (idx >= 0) {
                    config.ignoredRoleIds.splice(idx, 1);
                    await saveAntiSpamConfig(client, guildId, config);
                    return InteractionHelper.universalReply(interaction, {
                        embeds: [successEmbed('✅ Role Now Monitored', `Members with ${role} will now be monitored for spam again.`)],
                    });
                } else {
                    config.ignoredRoleIds.push(role.id);
                    await saveAntiSpamConfig(client, guildId, config);
                    return InteractionHelper.universalReply(interaction, {
                        embeds: [successEmbed('✅ Role Ignored', `Members with ${role} are now exempt from AntiSpam checks.`)],
                    });
                }
            }

            if (sub === 'status') {
                const config = await getAntiSpamConfig(client, guildId);

                return InteractionHelper.universalReply(interaction, {
                    embeds: [createEmbed({
                        title: '🛡️ AntiSpam Configuration',
                        color: 'primary',
                        fields: [
                            { name: 'Status', value: config.enabled ? '✅ Enabled' : '⏸️ Disabled', inline: true },
                            { name: 'Threshold', value: `${config.maxMessages} msgs / ${config.windowMs / 1000}s`, inline: true },
                            { name: 'Punishment', value: config.punishment, inline: true },
                            { name: 'Timeout Duration', value: `${config.timeoutDurationMs / 60000}m`, inline: true },
                            { name: 'Warn First', value: config.warnFirst ? 'Yes' : 'No', inline: true },
                            { name: 'Violations Before Ban', value: `${config.violationsBeforeBan}`, inline: true },
                            { name: 'Log Channel', value: config.logChannelId ? `<#${config.logChannelId}>` : 'Not set', inline: true },
                            { name: 'Ignored Channels', value: config.ignoredChannelIds.length ? config.ignoredChannelIds.map(id => `<#${id}>`).join(', ') : 'None', inline: false },
                            { name: 'Ignored Roles', value: config.ignoredRoleIds.length ? config.ignoredRoleIds.map(id => `<@&${id}>`).join(', ') : 'None', inline: false },
                        ],
                    })],
                });
            }
        } catch (error) {
            logger.error('AntiSpam command error:', error);
            await handleInteractionError(interaction, error, { subtype: 'antispam_failed' });
        }
    },
};
