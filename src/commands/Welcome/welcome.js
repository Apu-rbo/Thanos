import { getColor } from '../../config/bot.js';
import { SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder, MessageFlags } from 'discord.js';
import { errorEmbed } from '../../utils/embeds.js';
import { getWelcomeConfig, updateWelcomeConfig } from '../../utils/database.js';
import { formatWelcomeMessage } from '../../utils/welcome.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

export default {
    data: new SlashCommandBuilder()
        .setName('welcome')
        .setDescription('Configure the welcome system')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(subcommand =>
            subcommand
                .setName('setup')
                .setDescription('Set up the welcome message')
                .addChannelOption(option =>
                    option.setName('channel')
                        .setDescription('The channel to send welcome messages to')
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('message')
                        .setDescription('Welcome message. Variables: {user}, {username}, {server}, {memberCount}')
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('image')
                        .setDescription('URL of the image to include in the welcome message')
                        .setRequired(false))
                .addBooleanOption(option =>
                    option.setName('ping')
                        .setDescription('Whether to ping the user in the welcome message')
                        .setRequired(false)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('embed')
                .setDescription('Customize the welcome embed appearance')
                .addStringOption(option =>
                    option.setName('title')
                        .setDescription('Embed title. Variables: {user}, {username}, {server}, {memberCount}')
                        .setRequired(false))
                .addStringOption(option =>
                    option.setName('description')
                        .setDescription('Embed description. Variables: {user}, {username}, {server}, {memberCount}')
                        .setRequired(false))
                .addStringOption(option =>
                    option.setName('color')
                        .setDescription('Embed color as a hex code (e.g. #00ff00)')
                        .setRequired(false))
                .addStringOption(option =>
                    option.setName('footer')
                        .setDescription('Embed footer text. Variables: {user}, {username}, {server}, {memberCount}')
                        .setRequired(false))
                .addStringOption(option =>
                    option.setName('image')
                        .setDescription('URL of an image to display in the embed')
                        .setRequired(false))
                .addBooleanOption(option =>
                    option.setName('thumbnail')
                        .setDescription('Whether to show the new member\'s avatar as a thumbnail')
                        .setRequired(false)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('dm')
                .setDescription('Configure a direct message sent to new members')
                .addBooleanOption(option =>
                    option.setName('enabled')
                        .setDescription('Whether to DM new members when they join')
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('message')
                        .setDescription('DM message. Variables: {user}, {username}, {server}, {memberCount}')
                        .setRequired(false))),

    async execute(interaction) {
        try {
            const deferSuccess = await InteractionHelper.safeDefer(interaction);
            if (!deferSuccess) {
                logger.warn(`Welcome interaction defer failed`, {
                    userId: interaction.user.id,
                    guildId: interaction.guildId,
                    commandName: 'welcome'
                });
                return;
            }
        } catch (deferError) {
            logger.error(`Welcome defer error`, { error: deferError.message });
            return;
        }

        const { options, guild, client } = interaction;

        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
            return await InteractionHelper.safeEditReply(interaction, {
                embeds: [errorEmbed('Missing Permissions', 'You need the **Manage Server** permission to use `/welcome`.')],
                flags: MessageFlags.Ephemeral
            });
        }

        const subcommand = options.getSubcommand();

        if (subcommand === 'setup') {
            const channel = options.getChannel('channel');
            const message = options.getString('message');
            const image = options.getString('image');
            const ping = options.getBoolean('ping') ?? false;

            const existingConfig = await getWelcomeConfig(client, guild.id);
            if (existingConfig?.channelId) {
                logger.info(`[Welcome] Setup blocked because config already exists in channel ${existingConfig.channelId} for guild ${guild.id}`);
                return await InteractionHelper.safeEditReply(interaction, {
                    embeds: [errorEmbed(
                        'Welcome Setup Already Exists',
                        `Welcome is already configured for <#${existingConfig.channelId}>. Use **/welcome config** to customize channel, message, ping, or image.`
                    )],
                    flags: MessageFlags.Ephemeral
                });
            }
            
            if (!message || message.trim().length === 0) {
                logger.warn(`[Welcome] Empty message provided by ${interaction.user.tag} in ${guild.name}`);
                return await InteractionHelper.safeEditReply(interaction, {
                    embeds: [errorEmbed('Invalid Input', 'Welcome message cannot be empty')],
                    flags: MessageFlags.Ephemeral
                });
            }

            
            if (image) {
                try {
                    new URL(image);
                } catch (e) {
                    logger.warn(`[Welcome] Invalid image URL provided by ${interaction.user.tag}: ${image}`);
                    return await InteractionHelper.safeEditReply(interaction, {
                        embeds: [errorEmbed('Invalid Image URL', 'Please provide a valid image URL (must start with http:// or https://')],
                        flags: MessageFlags.Ephemeral
                    });
                }
            }

            try {
                await updateWelcomeConfig(client, guild.id, {
                    enabled: true,
                    channelId: channel.id,
                    welcomeMessage: message,
                    welcomeImage: image || undefined,
                    welcomePing: ping
                });

                logger.info(`[Welcome] Setup configured by ${interaction.user.tag} for guild ${guild.name} (${guild.id})`);

                const previewMessage = formatWelcomeMessage(message, {
                    user: interaction.user,
                    guild
                });

                const embed = new EmbedBuilder()
                    .setColor(getColor('success'))
                    .setTitle('✅ Welcome System Configured')
                    .setDescription(`Welcome messages will now be sent to ${channel}`)
                    .addFields(
                        { name: 'Message Preview', value: previewMessage },
                        { name: 'Ping User', value: ping ? '✅ Yes' : '❌ No' },
                        { name: 'Status', value: '✅ Enabled' }
                    )
                    .setFooter({ text: 'Tip: Use /welcome config to customize welcome settings' });

                if (image) {
                    embed.setImage(image);
                }

                await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
            } catch (error) {
                logger.error(`[Welcome] Failed to setup welcome system for guild ${guild.id}:`, error);
                await InteractionHelper.safeEditReply(interaction, {
                    embeds: [errorEmbed(
                        'Setup Failed',
                        'An error occurred while configuring the welcome system. Please try again.',
                        { showDetails: true }
                    )],
                    flags: MessageFlags.Ephemeral
                });
            }
        }

        if (subcommand === 'embed') {
            const title = options.getString('title');
            const description = options.getString('description');
            const color = options.getString('color');
            const footer = options.getString('footer');
            const image = options.getString('image');
            const thumbnail = options.getBoolean('thumbnail');

            if (color) {
                if (!/^#?[0-9A-Fa-f]{6}$/.test(color)) {
                    return await InteractionHelper.safeEditReply(interaction, {
                        embeds: [errorEmbed('Invalid Color', 'Please provide a valid hex color code (e.g. `#00ff00`).')],
                        flags: MessageFlags.Ephemeral
                    });
                }
            }

            if (image) {
                try {
                    new URL(image);
                } catch (e) {
                    return await InteractionHelper.safeEditReply(interaction, {
                        embeds: [errorEmbed('Invalid Image URL', 'Please provide a valid image URL (must start with http:// or https://)')],
                        flags: MessageFlags.Ephemeral
                    });
                }
            }

            try {
                const existingConfig = await getWelcomeConfig(client, guild.id);
                const currentEmbed = existingConfig.welcomeEmbed || {};

                const updatedEmbed = {
                    ...currentEmbed,
                    ...(title !== null && { title }),
                    ...(description !== null && { description }),
                    ...(color !== null && { color: getColor(color.startsWith('#') ? color : `#${color}`) }),
                    ...(footer !== null && { footer }),
                    ...(thumbnail !== null && { thumbnail }),
                };

                if (image) {
                    updatedEmbed.image = { url: image };
                }

                await updateWelcomeConfig(client, guild.id, { welcomeEmbed: updatedEmbed });

                logger.info(`[Welcome] Embed updated by ${interaction.user.tag} for guild ${guild.name} (${guild.id})`);

                const formatData = { user: interaction.user, guild };
                const previewEmbed = new EmbedBuilder()
                    .setColor(updatedEmbed.color || getColor('success'))
                    .setTitle(formatWelcomeMessage(updatedEmbed.title || '🎉 Welcome!', formatData))
                    .setDescription(formatWelcomeMessage(updatedEmbed.description || 'Welcome {user} to {server}!', formatData))
                    .setFooter({ text: formatWelcomeMessage(updatedEmbed.footer || `Welcome to ${guild.name}!`, formatData) });

                if (updatedEmbed.thumbnail) {
                    previewEmbed.setThumbnail(interaction.user.displayAvatarURL());
                }
                if (updatedEmbed.image?.url) {
                    previewEmbed.setImage(updatedEmbed.image.url);
                }

                await InteractionHelper.safeEditReply(interaction, {
                    content: '✅ Welcome embed updated. Preview:',
                    embeds: [previewEmbed]
                });
            } catch (error) {
                logger.error(`[Welcome] Failed to update embed for guild ${guild.id}:`, error);
                await InteractionHelper.safeEditReply(interaction, {
                    embeds: [errorEmbed(
                        'Update Failed',
                        'An error occurred while updating the welcome embed. Please try again.',
                        { showDetails: true }
                    )],
                    flags: MessageFlags.Ephemeral
                });
            }
        }

        if (subcommand === 'dm') {
            const enabled = options.getBoolean('enabled');
            const message = options.getString('message');

            if (enabled && (!message || message.trim().length === 0)) {
                const existingConfig = await getWelcomeConfig(client, guild.id);
                if (!existingConfig.dmMessage) {
                    return await InteractionHelper.safeEditReply(interaction, {
                        embeds: [errorEmbed(
                            'Message Required',
                            'Provide a `message` when enabling welcome DMs for the first time.'
                        )],
                        flags: MessageFlags.Ephemeral
                    });
                }
            }

            try {
                const updates = { dmEnabled: enabled };
                if (message !== null) {
                    updates.dmMessage = message;
                }

                const updatedConfig = await updateWelcomeConfig(client, guild.id, updates);

                logger.info(`[Welcome] DM ${enabled ? 'enabled' : 'disabled'} by ${interaction.user.tag} for guild ${guild.name} (${guild.id})`);

                const previewMessage = formatWelcomeMessage(updatedConfig.dmMessage || '', {
                    user: interaction.user,
                    guild
                });

                const embed = new EmbedBuilder()
                    .setColor(getColor(enabled ? 'success' : 'warning'))
                    .setTitle(enabled ? '✅ Welcome DM Enabled' : '🔕 Welcome DM Disabled')
                    .addFields(
                        { name: 'Status', value: enabled ? '✅ Enabled' : '❌ Disabled' }
                    );

                if (enabled && previewMessage) {
                    embed.addFields({ name: 'Message Preview', value: previewMessage });
                }

                if (enabled) {
                    embed.setFooter({ text: 'Note: members with DMs disabled will not receive this message.' });
                }

                await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
            } catch (error) {
                logger.error(`[Welcome] Failed to update DM settings for guild ${guild.id}:`, error);
                await InteractionHelper.safeEditReply(interaction, {
                    embeds: [errorEmbed(
                        'Update Failed',
                        'An error occurred while updating welcome DM settings. Please try again.',
                        { showDetails: true }
                    )],
                    flags: MessageFlags.Ephemeral
                });
            }
        }
    },
};
