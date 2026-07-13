import { getColor } from '../../config/bot.js';
import { 
    SlashCommandBuilder, 
    PermissionFlagsBits, 
    ChannelType, 
    ActionRowBuilder, 
    StringSelectMenuBuilder, 
    StringSelectMenuOptionBuilder, 
    RoleSelectMenuBuilder, 
    ModalBuilder, 
    TextInputBuilder, 
    TextInputStyle, 
    ButtonBuilder, 
    ButtonStyle, 
    MessageFlags, 
    ComponentType, 
    EmbedBuilder 
} from 'discord.js'; // Cleaned up unused non-existent component imports
import { createEmbed, errorEmbed, successEmbed, infoEmbed, warningEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { handleInteractionError, createError, TitanBotError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { createReactionRoleMessage, hasDangerousPermissions, getAllReactionRoleMessages, deleteReactionRoleMessage, parseEmoji } from '../../services/reactionRoleService.js';
import { logEvent, EVENT_TYPES } from '../../services/loggingService.js';

export default {
    data: new SlashCommandBuilder()
        .setName('reactroles')
        .setDescription('Manage reaction role assignments')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand(subcommand =>
            subcommand
                .setName('setup')
                .setDescription('Set up a new reaction role panel')
                .addChannelOption(option => 
                    option.setName('channel')
                        .setDescription('The channel to send the reaction role message to')
                        .setRequired(true)
                        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement) // Restrict channel types explicitly
                )
                .addStringOption(option =>
                    option.setName('title')
                        .setDescription('Title for the reaction role panel')
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option.setName('description')
                        .setDescription('Description for the reaction role panel')
                        .setRequired(true)
                )
                .addRoleOption(option =>
                    option.setName('role1')
                        .setDescription('First role to add')
                        .setRequired(true)
                )
                .addAttachmentOption(option =>
                    option.setName('image')
                        .setDescription('An image to display in the reaction role panel')
                        .setRequired(false)
                )
                .addStringOption(option =>
                    option.setName('mode')
                        .setDescription('How members select roles (default: dropdown menu)')
                        .setRequired(false)
                        .addChoices(
                            { name: 'Dropdown Menu', value: 'dropdown' },
                            { name: 'Emoji Reactions', value: 'reaction' },
                        )
                )
                .addStringOption(option =>
                    option.setName('emoji1')
                        .setDescription('Emoji for role1 (reaction mode only; defaults to 1️⃣)')
                        .setRequired(false)
                )
                .addStringOption(option =>
                    option.setName('emoji2')
                        .setDescription('Emoji for role2 (reaction mode only; defaults to 2️⃣)')
                        .setRequired(false)
                )
                .addStringOption(option =>
                    option.setName('emoji3')
                        .setDescription('Emoji for role3 (reaction mode only; defaults to 3️⃣)')
                        .setRequired(false)
                )
                .addStringOption(option =>
                    option.setName('emoji4')
                        .setDescription('Emoji for role4 (reaction mode only; defaults to 4️⃣)')
                        .setRequired(false)
                )
                .addStringOption(option =>
                    option.setName('emoji5')
                        .setDescription('Emoji for role5 (reaction mode only; defaults to 5️⃣)')
                        .setRequired(false)
                )
                .addRoleOption(option =>
                    option.setName('role2')
                        .setDescription('Second role to add')
                        .setRequired(false)
                )
                .addRoleOption(option =>
                    option.setName('role3')
                        .setDescription('Third role to add')
                        .setRequired(false)
                )
                .addRoleOption(option =>
                    option.setName('role4')
                        .setDescription('Fourth role to add')
                        .setRequired(false)
                )
                .addRoleOption(option =>
                    option.setName('role5')
                        .setDescription('Fifth role to add')
                        .setRequired(false)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('dashboard')
                .setDescription('Manage and configure your reaction role panels')
                .addStringOption(option =>
                    option
                        .setName('panel')
                        .setDescription('Select a reaction role panel to manage')
                        .setRequired(false)
                        .setAutocomplete(true)
                )
        ),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();

        try {
            if (subcommand === 'setup') {
                // Pre-emptively defer if your handleSetup reads databases or validates emojis
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                await handleSetup(interaction);
            } else if (subcommand === 'dashboard') {
                const selectedPanelId = interaction.options.getString('panel');
                await handleDashboard(interaction, selectedPanelId);
            }
        } catch (error) {
            await handleInteractionError(interaction, error, {
                type: 'command',
                commandName: 'reactroles',
                subcommand: subcommand
            });
        }
    },

    async autocomplete(interaction) {
        if (interaction.commandName !== 'reactroles') return;
        if (interaction.options.getSubcommand() !== 'dashboard') return;

        try {
            const guildId = interaction.guild.id;
            const client = interaction.client;
            
            let panels;
            try {
                panels = await getAllReactionRoleMessages(client, guildId);
            } catch (dbError) {
                return await interaction.respond([]).catch(() => {});
            }

            if (!panels || panels.length === 0) {
                return await interaction.respond([]).catch(() => {});
            }

            const guild = interaction.guild;
            const focusedValue = interaction.options.getFocused().toLowerCase();
            
            // Validate and filter down stale data fast using parallel execution
            const checkedPanels = await Promise.all(
                panels.map(async (panel) => {
                    if (!panel.messageId || !panel.channelId) return null;

                    const channel = guild.channels.cache.get(panel.channelId);
                    if (!channel) {
                        await deleteReactionRoleMessage(client, guildId, panel.messageId).catch(() => {});
                        return null;
                    }
                    
                    const msg = await channel.messages.fetch(panel.messageId).catch(() => null);
                    if (!msg) {
                        await deleteReactionRoleMessage(client, guildId, panel.messageId).catch(() => {});
                        return null;
                    }
                    return panel;
                })
            );

            // Strip null items out
            const validPanels = checkedPanels.filter(p => p !== null);

            // Filter by autocomplete focus search match
            const filteredPanels = validPanels.filter(panel => {
                const title = panel.title || `Panel [${panel.messageId}]`;
                return title.toLowerCase().includes(focusedValue);
            });

            // Map choices and respect Discord's 25 choice boundary
            const choices = filteredPanels.slice(0, 25).map(panel => ({
                name: (panel.title || `Panel [${panel.messageId}]`).substring(0, 100),
                value: panel.messageId
            }));

            await interaction.respond(choices);
        } catch (error) {
            logger.error('Error during reactroles autocomplete:', error);
            await interaction.respond([]).catch(() => {});
        }
    }
};
