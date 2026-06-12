import { PermissionFlagsBits } from 'discord.js';
import { logger } from '../utils/logger.js';
import { TitanBotError, ErrorTypes } from '../utils/errorHandler.js';
import { logModerationAction } from '../utils/moderation.js';





export class ModerationService {
  






  static validateHierarchy(moderator, target, action) {
    if (!moderator || !target) {
      return { valid: false, error: 'Invalid moderator or target' };
    }

    
    if (moderator.guild.ownerId === moderator.id) {
      return { valid: true };
    }

    
    if (moderator.roles.highest.position <= target.roles.highest.position) {
      return {
        valid: false,
        error: `You cannot ${action} a user with an equal or higher role than you.`
      };
    }

    return { valid: true };
  }

  






  static validateBotHierarchy(client, target, action) {
    if (!client || !target) {
      return { valid: false, error: 'Invalid client or target' };
    }

    const botMember = target.guild.members.me;
    if (!botMember) {
      return { valid: false, error: 'Bot is not in the guild' };
    }

    
    if (botMember.roles.highest.position <= target.roles.highest.position) {
      return {
        valid: false,
        error: `I cannot ${action} a user with an equal or higher role than me.`
      };
    }

    return { valid: true };
  }

  




  static async banUser({
    guild,
    user,
    moderator,
    reason = 'No reason provided',
    deleteDays = 0
  }) {
    try {
      if (!guild || !user || !moderator) {
        throw new TitanBotError(
          'Missing required parameters',
          ErrorTypes.VALIDATION,
          'Guild, user, and moderator are required'
        );
      }

      
      let targetMember = null;
      try {
        targetMember = await guild.members.fetch(user.id).catch(() => null);
      } catch (err) {
        logger.debug('Target not in guild, proceeding with ban');
      }

      // Hierarchy check
      if (targetMember) {
        const botCheck = this.validateBotHierarchy(guild.client, targetMember, 'ban');
        if (!botCheck.valid) {
          throw new TitanBotError(botCheck.error, ErrorTypes.PERMISSION, botCheck.error);
        }

        const modCheck = this.validateHierarchy(moderator, targetMember, 'ban');
        if (!modCheck.valid) {
          throw new TitanBotError(modCheck.error, ErrorTypes.PERMISSION, modCheck.error);
        }
      } else {
        // If target is not in guild, we can't check their roles easily.
        // As a safety measure, only allow users with ManageGuild or Administrator to ban non-members.
        const isOwner = guild.ownerId === moderator.id;
        const hasHighPerms = moderator.permissions.has([
            PermissionFlagsBits.ManageGuild,
            PermissionFlagsBits.Administrator
        ]);

        if (!isOwner && !hasHighPerms) {
            throw new TitanBotError(
                'You do not have sufficient permissions to ban users who are not in the server.',
                ErrorTypes.PERMISSION,
                'You need "Manage Server" or "Administrator" permissions to ban users not currently in the guild.'
            );
        }
      }


      
      await guild.members.ban(user.id, { reason });

      
      const caseId = await logModerationAction({
        client: guild.client,
        guild,
        event: {
          action: 'Member Banned',
          target: `${user.tag} (${user.id})`,
          executor: `${moderator.user.tag} (${moderator.id})`,
          reason,
          metadata: {
            userId: user.id,
            moderatorId: moderator.id,
            permanent: true,
            deleteDays
          }
        }
      });

      logger.info(`User banned: ${user.tag} by ${moderator.user.tag} in ${guild.name}`);
      
      return {
        success: true,
        caseId,
        user: user.tag,
        reason
      };
    } catch (error) {
      logger.error('Error banning user:', error);
      throw error;
    }
  }

  




  static async kickUser({
    guild,
    member,
    moderator,
    reason = 'No reason provided'
  }) {
    try {
      if (!guild || !member || !moderator) {
        throw new TitanBotError(
          'Missing required parameters',
          ErrorTypes.VALIDATION,
          'Guild, member, and moderator are required'
        );
      }

      
      const botCheck = this.validateBotHierarchy(guild.client, member, 'kick');
      if (!botCheck.valid) {
        throw new TitanBotError(botCheck.error, ErrorTypes.PERMISSION, botCheck.error);
      }

      const modCheck = this.validateHierarchy(moderator, member, 'kick');
      if (!modCheck.valid) {
        throw new TitanBotError(modCheck.error, ErrorTypes.PERMISSION, modCheck.error);
      }

      
      if (!member.kickable) {
        throw new TitanBotError(
          'Cannot kick member',
          ErrorTypes.PERMISSION,
          'I do not have permission to kick this member'
        );
      }

      
      await member.kick(reason);

      
      const caseId = await logModerationAction({
        client: guild.client,
        guild,
        event: {
          action: 'Member Kicked',
          target: `${member.user.tag} (${member.id})`,
          executor: `${moderator.user.tag} (${moderator.id})`,
          reason,
          metadata: {
            userId: member.id,
            moderatorId: moderator.id
          }
        }
      });

      logger.info(`User kicked: ${member.user.tag} by ${moderator.user.tag} in ${guild.name}`);
      
      return {
        success: true,
        caseId,
        user: member.user.tag,
        reason
      };
    } catch (error) {
      logger.error('Error kicking user:', error);
      throw error;
    }
  }

  




  static async timeoutUser({
    guild,
    member,
    moderator,
    durationMs,
    reason = 'No reason provided'
  }) {
    try {
      if (!guild || !member || !moderator || !durationMs) {
        throw new TitanBotError(
          'Missing required parameters',
          ErrorTypes.VALIDATION,
          'Guild, member, moderator, and duration are required'
        );
      }

      
      const botCheck = this.validateBotHierarchy(guild.client, member, 'timeout');
      if (!botCheck.valid) {
        throw new TitanBotError(botCheck.error, ErrorTypes.PERMISSION, botCheck.error);
      }

      const modCheck = this.validateHierarchy(moderator, member, 'timeout');
      if (!modCheck.valid) {
        throw new TitanBotError(modCheck.error, ErrorTypes.PERMISSION, modCheck.error);
      }

      
      if (!member.moderatable) {
        throw new TitanBotError(
          'Cannot timeout member',
          ErrorTypes.PERMISSION,
          'I cannot timeout this member'
        );
      }

      
      await member.timeout(durationMs, reason);

      
      const durationMinutes = Math.floor(durationMs / 60000);
      const caseId = await logModerationAction({
        client: guild.client,
        guild,
        event: {
          action: 'Member Timed Out',
          target: `${member.user.tag} (${member.id})`,
          executor: `${moderator.user.tag} (${moderator.id})`,
          reason,
          duration: `${durationMinutes} minutes`,
          metadata: {
            userId: member.id,
            moderatorId: moderator.id,
            durationMs
          }
        }
      });

      logger.info(`User timed out: ${member.user.tag} by ${moderator.user.tag} in ${guild.name}`);
      
      return {
        success: true,
        caseId,
        user: member.user.tag,
        duration: durationMinutes,
        reason
      };
    } catch (error) {
      logger.error('Error timing out user:', error);
      throw error;
    }
  }

  




  static async removeTimeoutUser({
    guild,
    member,
    moderator,
    reason = 'Timeout removed by moderator'
  }) {
    try {
      if (!guild || !member || !moderator) {
        throw new TitanBotError(
          'Missing required parameters',
          ErrorTypes.VALIDATION,
          'Guild, member, and moderator are required'
        );
      }

      
      if (!member.moderatable) {
        throw new TitanBotError(
          'Cannot modify member',
          ErrorTypes.PERMISSION,
          'I cannot modify this member'
        );
      }

      
      if (!member.isCommunicationDisabled()) {
        throw new TitanBotError(
          'User not timed out',
          ErrorTypes.VALIDATION,
          `${member.user.tag} is not currently timed out`
        );
      }

      
      await member.timeout(null, reason);

      
      await logModerationAction({
        client: guild.client,
        guild,
        event: {
          action: 'Member Untimeouted',
          target: `${member.user.tag} (${member.id})`,
          executor: `${moderator.user.tag} (${moderator.id})`,
          reason,
          metadata: {
            userId: member.id,
            moderatorId: moderator.id
          }
        }
      });

      logger.info(`Timeout removed: ${member.user.tag} by ${moderator.user.tag} in ${guild.name}`);
      
      return {
        success: true,
        user: member.user.tag
      };
    } catch (error) {
      logger.error('Error removing timeout:', error);
      throw error;
    }
  }

  




  static async unbanUser({
    guild,
    user,
    moderator,
    reason = 'No reason provided'
  }) {
    try {
      if (!guild || !user || !moderator) {
        throw new TitanBotError(
          'Missing required parameters',
          ErrorTypes.VALIDATION,
          'Guild, user, and moderator are required'
        );
      }

      
      const bans = await guild.bans.fetch();
      const banInfo = bans.get(user.id);

      if (!banInfo) {
        throw new TitanBotError(
          'User not banned',
          ErrorTypes.VALIDATION,
          `${user.tag} is not currently banned from this server`
        );
      }

      
      await guild.members.unban(user.id, reason);

      
      const caseId = await logModerationAction({
        client: guild.client,
        guild,
        event: {
          action: 'Member Unbanned',
          target: `${user.tag} (${user.id})`,
          executor: `${moderator.user.tag} (${moderator.id})`,
          reason,
          metadata: {
            userId: user.id,
            moderatorId: moderator.id
          }
        }
      });

      logger.info(`User unbanned: ${user.tag} by ${moderator.user.tag} in ${guild.name}`);
      
      return {
        success: true,
        caseId,
        user: user.tag,
        reason
      };
    } catch (error) {
      logger.error('Error unbanning user:', error);
      throw error;
    }
  }
  static tempbanKey(guildId, userId) {
    return `temp:tempban:${guildId}:${userId}`;
  }

  static tempbanIndexKey(guildId) {
    return `cache:tempban_index:${guildId}`;
  }

  static async tempbanUser({
    client,
    guild,
    user,
    moderator,
    durationMs,
    reason = 'No reason provided',
    deleteDays = 0
  }) {
    try {
      if (!guild || !user || !moderator || !durationMs) {
        throw new TitanBotError(
          'Missing required parameters',
          ErrorTypes.VALIDATION,
          'Guild, user, moderator, and duration are required'
        );
      }

      const banResult = await this.banUser({ guild, user, moderator, reason, deleteDays });

      const expiresAt = Date.now() + durationMs;
      const ttlSeconds = Math.ceil(durationMs / 1000);

      await client.db.set(
        this.tempbanKey(guild.id, user.id),
        {
          guildId: guild.id,
          userId: user.id,
          moderatorId: moderator.id,
          reason,
          expiresAt,
          caseId: banResult.caseId
        },
        ttlSeconds
      );

      const index = (await client.db.get(this.tempbanIndexKey(guild.id))) || [];
      if (!index.includes(user.id)) {
        index.push(user.id);
        await client.db.set(this.tempbanIndexKey(guild.id), index);
      }

      logger.info(`User temp-banned: ${user.tag} by ${moderator.user.tag} in ${guild.name} for ${ttlSeconds}s`);

      return {
        success: true,
        caseId: banResult.caseId,
        user: user.tag,
        reason,
        expiresAt
      };
    } catch (error) {
      logger.error('Error temp-banning user:', error);
      throw error;
    }
  }

  static async checkExpiredTempbans(client) {
    if (!client?.db) return;

    for (const guild of client.guilds.cache.values()) {
      try {
        const index = (await client.db.get(this.tempbanIndexKey(guild.id))) || [];
        if (index.length === 0) continue;

        const remaining = [];
        for (const userId of index) {
          const record = await client.db.get(this.tempbanKey(guild.id, userId));

          if (!record) {
            try {
              const bans = await guild.bans.fetch();
              if (bans.has(userId)) {
                await guild.members.unban(userId, 'Temporary ban expired');

                await logModerationAction({
                  client,
                  guild,
                  event: {
                    action: 'Member Unbanned (Tempban Expired)',
                    target: userId,
                    executor: `${client.user.tag} (${client.user.id})`,
                    reason: 'Temporary ban duration elapsed',
                    metadata: { userId, automatic: true }
                  }
                });

                logger.info(`Tempban expired, unbanned ${userId} in ${guild.name}`);
              }
            } catch (err) {
              logger.warn(`Failed to auto-unban ${userId} in ${guild.name}:`, err.message);
            }
            continue;
          }

          if (record.expiresAt && record.expiresAt <= Date.now()) {
            try {
              await guild.members.unban(userId, 'Temporary ban expired');

              await logModerationAction({
                client,
                guild,
                event: {
                  action: 'Member Unbanned (Tempban Expired)',
                  target: userId,
                  executor: `${client.user.tag} (${client.user.id})`,
                  reason: 'Temporary ban duration elapsed',
                  metadata: { userId, automatic: true }
                }
              });

              await client.db.delete(this.tempbanKey(guild.id, userId));
              logger.info(`Tempban expired, unbanned ${userId} in ${guild.name}`);
            } catch (err) {
              logger.warn(`Failed to auto-unban ${userId} in ${guild.name}:`, err.message);
            }
            continue;
          }

          remaining.push(userId);
        }

        if (remaining.length !== index.length) {
          await client.db.set(this.tempbanIndexKey(guild.id), remaining);
        }
      } catch (error) {
        logger.error(`Error checking expired tempbans for ${guild.name}:`, error);
      }
    }
  }
}
