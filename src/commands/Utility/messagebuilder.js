import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } from 'discord.js';

export default {
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
                        .setDescription('Title for the embed (only if embed is true)')
                        .setRequired(false)
                        .setMaxLength(256)
                )
                .addStringOption(option =>
                    option
                        .setName('embed_color')
                        .setDescription('Hex color e.g. #FF0000 (only if embed is true)')
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
                        .setDescription('Title for the embed (only if embed is true)')
                        .setRequired(false)
                        .setMaxLength(256)
                )
                .addStringOption(option =>
                    option
                        .setName('embed_color')
                        .setDescription('Hex color e.g. #FF0000 (only if embed is true)')
                        .setRequired(false)
                )
        ),

    async execute(interaction) {
        const subcommand    = interaction.options.getSubcommand();
        const useEmbed      = interaction.options.getBoolean('embed') ?? false;
        const embedTitle    = interaction.options.getString('embed_title');
        const embedColorRaw = interaction.options.getString('embed_color') ?? '#5865F2';

        // Discord's text option is single-line — users can't press Enter directly,
        // so \n and \t typed literally get converted to real line breaks/tabs.
        const rawContent = interaction.options.getString('message');
        const messageContent = rawContent
            .replace(/\\n/g, '\n')
            .replace(/\\t/g, '\t');

        let embedColor = 0x5865F2;
        try {
            const parsed = parseInt(embedColorRaw.replace('#', ''), 16);
            if (!isNaN(parsed)) embedColor = parsed;
        } catch { /* fallback to default */ }

        // Allow @everyone/@here/role pings if the sender genuinely typed them —
        // Discord suppresses these by default unless explicitly allowed.
        const allowedMentions = { parse: ['everyone', 'roles', 'users'] };

        let payload;
        if (useEmbed) {
            const embed = new EmbedBuilder()
                .setDescription(messageContent)
                .setColor(embedColor)
                .setTimestamp()
                .setFooter({ text: `Sent by ${interaction.user.tag}` });
            if (embedTitle) embed.setTitle(embedTitle);
            payload = { embeds: [embed], allowedMentions };
        } else {
            payload = { content: messageContent, allowedMentions };
        }

        // ── CHANNEL ──
        if (subcommand === 'channel') {
            const targetChannel = interaction.options.getChannel('target');

            if (!targetChannel.isTextBased()) {
                return interaction.reply({ content: '❌ That is not a text channel.', ephemeral: true });
            }

            const botMember = interaction.guild.members.me;
            if (!targetChannel.permissionsFor(botMember).has(PermissionFlagsBits.SendMessages)) {
                return interaction.reply({
                    content: `❌ I don't have permission to send messages in ${targetChannel}.`,
                    ephemeral: true,
                });
            }

            try {
                await targetChannel.send(payload);
                return interaction.reply({ content: `✅ Message sent to ${targetChannel}.`, ephemeral: true });
            } catch (err) {
                return interaction.reply({ content: `❌ Failed to send: ${err.message}`, ephemeral: true });
            }
        }

        // ── DM ──
        if (subcommand === 'dm') {
            const targetUser = interaction.options.getUser('target');

            if (targetUser.bot) {
                return interaction.reply({ content: '❌ You cannot DM a bot.', ephemeral: true });
            }

            try {
                await targetUser.send(payload);
                return interaction.reply({ content: `✅ DM sent to **${targetUser.tag}**.`, ephemeral: true });
            } catch (err) {
                const reason = err.code === 50007
                    ? 'Their DMs are closed or they blocked the bot.'
                    : err.message;
                return interaction.reply({
                    content: `❌ Could not DM **${targetUser.tag}**. ${reason}`,
                    ephemeral: true,
                });
            }
        }
    },
};
