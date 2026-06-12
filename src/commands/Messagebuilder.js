const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('messagebuilder')
        .setDescription('Send a message to any channel or a user\'s DM (Admin only)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand(subcommand =>
            subcommand
                .setName('channel')
                .setDescription('Send a message to a specific channel')
                .addChannelOption(option =>
                    option
                        .setName('target')
                        .setDescription('The channel to send the message to')
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option
                        .setName('message')
                        .setDescription('The message content to send')
                        .setRequired(true)
                        .setMaxLength(2000)
                )
                .addBooleanOption(option =>
                    option
                        .setName('embed')
                        .setDescription('Send as an embed? (default: false)')
                        .setRequired(false)
                )
                .addStringOption(option =>
                    option
                        .setName('embed_title')
                        .setDescription('Title for the embed (only used if embed is true)')
                        .setRequired(false)
                        .setMaxLength(256)
                )
                .addStringOption(option =>
                    option
                        .setName('embed_color')
                        .setDescription('Hex color for embed, e.g. #FF0000 (only used if embed is true)')
                        .setRequired(false)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('dm')
                .setDescription('Send a DM to a specific user')
                .addUserOption(option =>
                    option
                        .setName('target')
                        .setDescription('The user to DM')
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option
                        .setName('message')
                        .setDescription('The message content to send')
                        .setRequired(true)
                        .setMaxLength(2000)
                )
                .addBooleanOption(option =>
                    option
                        .setName('embed')
                        .setDescription('Send as an embed? (default: false)')
                        .setRequired(false)
                )
                .addStringOption(option =>
                    option
                        .setName('embed_title')
                        .setDescription('Title for the embed (only used if embed is true)')
                        .setRequired(false)
                        .setMaxLength(256)
                )
                .addStringOption(option =>
                    option
                        .setName('embed_color')
                        .setDescription('Hex color for embed, e.g. #FF0000 (only used if embed is true)')
                        .setRequired(false)
                )
        ),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();
        const messageContent = interaction.options.getString('message');
        const useEmbed = interaction.options.getBoolean('embed') ?? false;
        const embedTitle = interaction.options.getString('embed_title');
        const embedColorRaw = interaction.options.getString('embed_color') ?? '#5865F2';

        // Parse hex color safely
        let embedColor = 0x5865F2;
        try {
            const cleaned = embedColorRaw.replace('#', '');
            const parsed = parseInt(cleaned, 16);
            if (!isNaN(parsed)) embedColor = parsed;
        } catch {
            // fallback to default Discord blurple
        }

        // Build the payload
        let payload;
        if (useEmbed) {
            const embed = new EmbedBuilder()
                .setDescription(messageContent)
                .setColor(embedColor)
                .setTimestamp()
                .setFooter({ text: `Sent by ${interaction.user.tag}` });

            if (embedTitle) embed.setTitle(embedTitle);
            payload = { embeds: [embed] };
        } else {
            payload = { content: messageContent };
        }

        // ── CHANNEL subcommand ──
        if (subcommand === 'channel') {
            const targetChannel = interaction.options.getChannel('target');

            // Verify it's a text-based channel
            if (!targetChannel.isTextBased()) {
                return interaction.reply({
                    content: '❌ The selected channel is not a text channel.',
                    ephemeral: true,
                });
            }

            // Check bot has permission to send there
            const botMember = interaction.guild.members.me;
            if (!targetChannel.permissionsFor(botMember).has(PermissionFlagsBits.SendMessages)) {
                return interaction.reply({
                    content: `❌ I don't have permission to send messages in ${targetChannel}.`,
                    ephemeral: true,
                });
            }

            try {
                await targetChannel.send(payload);
                return interaction.reply({
                    content: `✅ Message sent to ${targetChannel} successfully.`,
                    ephemeral: true,
                });
            } catch (err) {
                console.error('[MessageBuilder] Channel send error:', err);
                return interaction.reply({
                    content: `❌ Failed to send message: ${err.message}`,
                    ephemeral: true,
                });
            }
        }

        // ── DM subcommand ──
        if (subcommand === 'dm') {
            const targetUser = interaction.options.getUser('target');

            if (targetUser.bot) {
                return interaction.reply({
                    content: '❌ You cannot DM a bot.',
                    ephemeral: true,
                });
            }

            try {
                await targetUser.send(payload);
                return interaction.reply({
                    content: `✅ DM sent to **${targetUser.tag}** successfully.`,
                    ephemeral: true,
                });
            } catch (err) {
                // Common reason: user has DMs disabled
                const reason = err.code === 50007
                    ? 'Their DMs are closed or they have blocked the bot.'
                    : err.message;

                return interaction.reply({
                    content: `❌ Could not send DM to **${targetUser.tag}**. ${reason}`,
                    ephemeral: true,
                });
            }
        }
    },
};
