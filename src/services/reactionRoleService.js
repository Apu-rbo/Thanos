// Keep your existing validation helper imports here at the top...

export async function createReactionRoleMessage(client, guildId, channelId, messageId, roleIds, options = {}) {
    try {
        validateGuildId(guildId);
        validateMessageId(messageId);
        
        if (!channelId || typeof channelId !== 'string' || !/^\d{17,19}$/.test(channelId)) {
            throw createError(
                `Invalid channel ID: ${channelId}`,
                ErrorTypes.VALIDATION,
                'Invalid channel ID provided.',
                { channelId }
            );
        }
        
        if (!Array.isArray(roleIds) || roleIds.length === 0) {
            throw createError(
                'No roles provided',
                ErrorTypes.VALIDATION,
                'You must provide at least one role.',
                { roleIds }
            );
        }
        
        if (roleIds.length > MAX_ROLES_PER_MESSAGE) {
            throw createError(
                `Too many roles: ${roleIds.length}`,
                ErrorTypes.VALIDATION,
                `You can only add up to ${MAX_ROLES_PER_MESSAGE} roles per reaction role message.`,
                { roleIds, limit: MAX_ROLES_PER_MESSAGE }
            );
        }
        
        for (const roleId of roleIds) {
            validateRoleId(roleId);
            await validateRoleSafety(client, guildId, roleId);
        }

        const mode = options.mode === 'reaction' ? 'reaction' : 'dropdown';

        const reactionRoleData = {
            guildId,
            channelId,
            messageId,
            roles: roleIds,
            mode,
            createdAt: new Date().toISOString()
        };

        if (mode === 'reaction' && options.emojiRoleMap) {
            reactionRoleData.emojiRoleMap = options.emojiRoleMap;
        }
        
        const key = `reaction_roles:${guildId}:${messageId}`;
        await client.db.set(key, reactionRoleData);
        
        logger.info(`Created reaction role message ${messageId} in guild ${guildId} with ${roleIds.length} roles (mode: ${mode})`);
        return reactionRoleData;
    } catch (error) {
        if (error.name === 'TitanBotError') {
            throw error;
        }
        logger.error(`Error creating reaction role message in guild ${guildId}:`, error);
        throw createError(
            `Database error creating reaction role message`,
            ErrorTypes.DATABASE,
            'Failed to save reaction role data. Please try again.',
            { guildId, messageId, originalError: error.message }
        );
    }
}

// 🟢 ADD ALIAS EXPORT TO FIX CRASH IN EXTERNAL FILES
export { createReactionRoleMessage as addReactionRole };

export function parseEmoji(emojiString) {
    if (!emojiString || typeof emojiString !== 'string') return null;

    const trimmed = emojiString.trim();
    
    // Handles standard custom emojis (<:name:id>) and animated ones (<a:name:id>)
    const customMatch = trimmed.match(/^<a?:\w+:(\d+)>$/);
    if (customMatch) {
        return { key: customMatch[1], reactable: trimmed };
    }

    // Handles native unicode emojis cleanly
    const nativeEmojiRegex = /\p{Extended_Pictographic}/u;
    if (nativeEmojiRegex.test(trimmed)) {
        return { key: trimmed, reactable: trimmed };
    }

    return null;
}
