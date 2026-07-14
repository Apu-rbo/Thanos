import { Events } from 'discord.js';
import { getReactionRoleMessage } from '../services/reactionRoleService.js';
import { logEvent, EVENT_TYPES } from '../services/loggingService.js';
import { logger } from '../utils/logger.js';

async function resolveReactionContext(reaction, user) {
    if (user.bot) return null;

    if (reaction.partial) {
        try {
            await reaction.fetch();
        } catch (error) {
            logger.debug('Failed to fetch partial reaction:', error.message);
            return null;
        }
    }

    if (reaction.message.partial) {
        try {
            await reaction.message.fetch();
        } catch (error) {
            logger.debug('Failed to fetch partial message for reaction role:', error.message);
            return null;
        }
    }

    const { message } = reaction;
    if (!message.guild) return null;

    return { message, guild: message.guild };
}

async function handleReactionAdd(client, reaction, user) {
    try {
        const ctx = await resolveReactionContext(reaction, user);
        if (!ctx) return;
        const { message, guild } = ctx;

        const reactionRoleMessage = await getReactionRoleMessage(client, guild.id, message.id);
        if (!reactionRoleMessage || reactionRoleMessage.mode !== 'reaction' || !reactionRoleMessage.emojiRoleMap) return;

        const emojiKey = reaction.emoji.id || reaction.emoji.name;
        const roleId = reactionRoleMessage.emojiRoleMap[emojiKey];
        if (!roleId) return;

        const member = await guild.members.fetch(user.id).catch(() => null);
        if (!member) return;

        const role = guild.roles.cache.get(roleId);
        if (!role) return;
        if (member.roles.cache.has(roleId)) return;

        await member.roles.add(role, 'Reaction role assignment');

        try {
            await logEvent({
                client,
                guildId: guild.id,
                eventType: EVENT_TYPES.REACTION_ROLE_ADD,
                data: {
                    description: `Reaction role assigned to ${user.tag}`,
                    userId: user.id,
                    channelId: message.channel.id,
                    fields: [
                        { name: '👤 Member', value: `${user.tag} (${user.id})`, inline: true },
                        { name: '🏷️ Role', value: role.toString(), inline: true },
                        { name: '😊 Reaction', value: reaction.emoji.toString(), inline: true }
                    ]
                }
            });
        } catch (error) {
            logger.debug('Error logging reaction role add:', error);
        }
    } catch (error) {
        logger.error('Error in handleReactionAdd:', error);
    }
}

async function handleReactionRemove(client, reaction, user) {
    try {
        const ctx = await resolveReactionContext(reaction, user);
        if (!ctx) return;
        const { message, guild } = ctx;

        const reactionRoleMessage = await getReactionRoleMessage(client, guild.id, message.id);
        if (!reactionRoleMessage || reactionRoleMessage.mode !== 'reaction' || !reactionRoleMessage.emojiRoleMap) return;

        const emojiKey = reaction.emoji.id || reaction.emoji.name;
        const roleId = reactionRoleMessage.emojiRoleMap[emojiKey];
        if (!roleId) return;

        const member = await guild.members.fetch(user.id).catch(() => null);
        if (!member) return;

        const role = guild.roles.cache.get(roleId);
        if (!role) return;
        if (!member.roles.cache.has(roleId)) return;

        await member.roles.remove(role, 'Reaction role removal');

        try {
            await logEvent({
                client,
                guildId: guild.id,
                eventType: EVENT_TYPES.REACTION_ROLE_REMOVE,
                data: {
                    description: `Reaction role removed from ${user.tag}`,
                    userId: user.id,
                    channelId: message.channel.id,
                    fields: [
                        { name: '👤 Member', value: `${user.tag} (${user.id})`, inline: true },
                        { name: '🏷️ Role', value: role.toString(), inline: true },
                        { name: '😊 Reaction', value: reaction.emoji.toString(), inline: true }
                    ]
                }
            });
        } catch (error) {
            logger.debug('Error logging reaction role remove:', error);
        }
    } catch (error) {
        logger.error('Error in handleReactionRemove:', error);
    }
}

export function setupReactionRoleListeners(client) {
    client.on(Events.MessageReactionAdd, async (reaction, user) => {
        await handleReactionAdd(client, reaction, user);
    });

    client.on(Events.MessageReactionRemove, async (reaction, user) => {
        await handleReactionRemove(client, reaction, user);
    });

    logger.info('✅ Reaction role (emoji mode) listeners registered');
}
