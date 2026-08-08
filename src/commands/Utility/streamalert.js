import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { createEmbed, successEmbed, errorEmbed } from '../../utils/embeds.js';
import { handleInteractionError } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';
import {
    getTwitchUser,
    resolveYoutubeChannel,
    getStreamAlertConfig,
    saveStreamAlertConfig,
    streamerKey,
} from '../../services/streamAlertService.js';

export default {
    data: new SlashCommandBuilder()
        .setName('streamalert')
        .setDescription('Get notified in this server when a streamer goes live')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)

        .addSubcommand(sub =>
            sub.setName('add')
                .setDescription('Start tracking a streamer')
                .addStringOption(o =>
                    o.setName('platform').setDescription('Which platform').setRequired(true)
                        .addChoices(
                            { name: 'Twitch', value: 'twitch' },
                            { name: 'YouTube', value: 'youtube' },
                        )
                )
                .addStringOption(o =>
                    o.setName('channel_id')
                        .setDescription('Twitch: username. YouTube: @handle or channel ID (starts with UC...)')
                        .setRequired(true)
                )
                .addChannelOption(o =>
                    o.setName('channel').setDescription('Discord channel to post the alert in').setRequired(true)
                        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                )
                .addStringOption(o =>
                    o.setName('mention')
                        .setDescription('Who to ping when they go live')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Everyone', value: 'everyone' },
                            { name: 'Here (only active members)', value: 'here' },
                            { name: 'A specific role', value: 'role' },
                            { name: 'No mention', value: 'none' },
                        )
                )
                .addRoleOption(o => o.setName('role').setDescription('Role to ping (only if mention is "A specific role")').setRequired(false))
                .addStringOption(o =>
                    o.setName('message')
                        .setDescription('Custom message. Use {streamer} {title} {game} {url}')
                        .setRequired(false)
                )
        )

        .addSubcommand(sub =>
            sub.setName('remove')
                .setDescription('Stop tracking a streamer')
                .addStringOption(o =>
                    o.setName('platform').setDescription('Which platform').setRequired(true)
                        .addChoices(
                            { name: 'Twitch', value: 'twitch' },
                            { name: 'YouTube', value: 'youtube' },
                        )
                )
                .addStringOption(o => o.setName('channel_id').setDescription('The username/channel ID you used when adding').setRequired(true))
        )

        .addSubcommand(sub =>
            sub.setName('list')
                .setDescription('List all tracked streamers in this server')
        ),

    category: 'utility',

    async execute(interaction, guildConfig, client) {
        const sub = interaction.options.getSubcommand();
        const guildId = interaction.guild.id;

        try {
            if (sub === 'add') {
                await InteractionHelper.safeDefer(interaction, { ephemeral: true });

                const platform = interaction.options.getString('platform');
                const rawInput = interaction.options.getString('channel_id').trim();
                const discordChannel = interaction.options.getChannel('channel');
                const mentionType = interaction.options.getString('mention');
                const role = interaction.options.getRole('role');
                const customMessage = interaction.options.getString('message');

                if (mentionType === 'role' && !role) {
                    return InteractionHelper.safeEditReply(interaction, {
                        embeds: [errorEmbed('Role Required', 'You chose "A specific role" but didn\'t select one.')],
                    });
                }

                if (!discordChannel.permissionsFor(interaction.guild.members.me).has(PermissionFlagsBits.SendMessages)) {
                    return InteractionHelper.safeEditReply(interaction, {
                        embeds: [errorEmbed('Missing Permission', `I don't have permission to send messages in ${discordChannel}.`)],
                    });
                }

                let identifier, displayName;

                if (platform === 'twitch') {
                    let twitchUser;
                    try {
                        twitchUser = await getTwitchUser(rawInput.toLowerCase().replace(/^@/, ''));
                    } catch (err) {
                        logger.error('[StreamAlert] Twitch API error on add:', err);
                        return InteractionHelper.safeEditReply(interaction, {
                            embeds: [errorEmbed('Twitch API Error', `Couldn't verify that username: ${err.message}`)],
                        });
                    }
                    if (!twitchUser) {
                        return InteractionHelper.safeEditReply(interaction, {
                            embeds: [errorEmbed('Streamer Not Found', `No Twitch account found for **${rawInput}**. Check the spelling.`)],
                        });
                    }
                    identifier = twitchUser.login;
                    displayName = twitchUser.display_name;
                } else {
                    let resolved;
                    try {
                        resolved = await resolveYoutubeChannel(rawInput);
                    } catch (err) {
                        logger.error('[StreamAlert] YouTube API error on add:', err);
                        return InteractionHelper.safeEditReply(interaction, {
                            embeds: [errorEmbed('YouTube API Error', `Couldn't verify that channel: ${err.message}`)],
                        });
                    }
                    if (!resolved) {
                        return InteractionHelper.safeEditReply(interaction, {
                            embeds: [errorEmbed('Channel Not Found', `Couldn't find a YouTube channel for **${rawInput}**. Try their @handle or the full channel ID (starts with UC).`)],
                        });
                    }
                    identifier = resolved.channelId;
                    displayName = resolved.displayName;
                }

                const key = streamerKey(platform, identifier);
                const config = await getStreamAlertConfig(client, guildId);

                if (config.streamers[key]) {
                    return InteractionHelper.safeEditReply(interaction, {
                        embeds: [errorEmbed('Already Tracked', `**${displayName}** is already being tracked in this server.`)],
                    });
                }

                config.streamers[key] = {
                    platform,
                    identifier,
                    displayName,
                    channelId: discordChannel.id,
                    mentionType,
                    roleId: role?.id ?? null,
                    customMessage: customMessage || null,
                    isLive: false,
                    lastStreamId: null,
                    addedBy: interaction.user.id,
                };
                await saveStreamAlertConfig(client, guildId, config);

                const quotaNote = platform === 'youtube'
                    ? '\n\n⚠️ YouTube checks run every ~15 minutes due to API quota limits (this is a platform restriction, not a bug).'
                    : '';

                return InteractionHelper.safeEditReply(interaction, {
                    embeds: [successEmbed(
                        '✅ Now Tracking',
                        `**${displayName}** (${platform}) will trigger an alert in ${discordChannel} when they go live.\nMention: **${mentionType === 'role' ? role : mentionType}**${quotaNote}`
                    )],
                });
            }

            if (sub === 'remove') {
                await InteractionHelper.safeDefer(interaction, { ephemeral: true });

                const platform = interaction.options.getString('platform');
                const rawInput = interaction.options.getString('channel_id').trim();
                const key = streamerKey(platform, rawInput);

                const config = await getStreamAlertConfig(client, guildId);

                if (!config.streamers[key]) {
                    return InteractionHelper.safeEditReply(interaction, {
                        embeds: [errorEmbed('Not Tracked', `No tracked ${platform} streamer matches **${rawInput}**. Check \`/streamalert list\` for exact values.`)],
                    });
                }

                const displayName = config.streamers[key].displayName;
                delete config.streamers[key];
                await saveStreamAlertConfig(client, guildId, config);

                return InteractionHelper.safeEditReply(interaction, {
                    embeds: [successEmbed('✅ Removed', `**${displayName}** is no longer tracked.`)],
                });
            }

            if (sub === 'list') {
                await InteractionHelper.safeDefer(interaction, { ephemeral: true });

                const config = await getStreamAlertConfig(client, guildId);
                const entries = Object.entries(config.streamers);

                if (entries.length === 0) {
                    return InteractionHelper.safeEditReply(interaction, {
                        embeds: [createEmbed({ title: '📺 Stream Alerts', description: 'No streamers tracked yet. Use `/streamalert add`.', color: 'secondary' })],
                    });
                }

                const lines = entries.map(([, data]) => {
                    const mention = data.mentionType === 'role' ? `<@&${data.roleId}>` : `@${data.mentionType}`;
                    const status = data.isLive ? '🔴 LIVE' : '⚫ Offline';
                    const platformEmoji = data.platform === 'twitch' ? '🟣' : '🔴';
                    return `${platformEmoji} **${data.displayName}** (${data.platform}) — ${status}\n<#${data.channelId}> • \`${data.identifier}\` • pings ${data.mentionType === 'none' ? 'no one' : mention}`;
                });

                return InteractionHelper.safeEditReply(interaction, {
                    embeds: [createEmbed({ title: `📺 Tracked Streamers (${entries.length})`, description: lines.join('\n\n'), color: 'primary' })],
                });
            }
        } catch (error) {
            logger.error('StreamAlert command error:', error);
            await handleInteractionError(interaction, error, { subtype: 'streamalert_failed' });
        }
    },
};
