import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import { fileURLToPath } from 'url';
import path from 'path';
import { logger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FONT_PATH = path.join(__dirname, '../assets/fonts/NotoSansCJK-SC-Bold.otf');
const FONT_FAMILY = 'TazzWelcome';

let fontRegistered = false;
try {
    fontRegistered = GlobalFonts.registerFromPath(FONT_PATH, FONT_FAMILY);
    if (fontRegistered) {
        logger.info('[WelcomeCard] Custom font registered successfully.');
    } else {
        logger.warn('[WelcomeCard] Custom font failed to register, falling back to default font.');
    }
} catch (err) {
    logger.warn(`[WelcomeCard] Could not load custom font: ${err.message}`);
}

const FONT_FALLBACK = fontRegistered ? FONT_FAMILY : 'sans-serif';

const CARD_WIDTH = 900;
const CARD_HEIGHT = 350;
const AVATAR_SIZE = 160;

async function fetchImageBuffer(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch image (${res.status})`);
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
}

function drawRoundedRect(ctx, x, y, width, height, radius) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + width, y, x + width, y + height, radius);
    ctx.arcTo(x + width, y + height, x, y + height, radius);
    ctx.arcTo(x, y + height, x, y, radius);
    ctx.arcTo(x, y, x + width, y, radius);
    ctx.closePath();
}

function drawDefaultBackground(ctx) {
    // Diagonal gradient background as a fallback when no custom background is set
    const gradient = ctx.createLinearGradient(0, 0, CARD_WIDTH, CARD_HEIGHT);
    gradient.addColorStop(0, '#1a0e2e');
    gradient.addColorStop(0.5, '#3d1a52');
    gradient.addColorStop(1, '#0f0817');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

    // Decorative glow circles
    for (const [x, y, r, color] of [
        [120, 60, 180, 'rgba(236, 72, 153, 0.15)'],
        [780, 300, 220, 'rgba(139, 92, 246, 0.15)'],
    ]) {
        const glow = ctx.createRadialGradient(x, y, 0, x, y, r);
        glow.addColorStop(0, color);
        glow.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
    }
}

/**
 * Generate a welcome card image buffer (PNG) for a new member.
 * @param {Object} opts
 * @param {string} opts.username - display name to show
 * @param {string} opts.avatarUrl - member's avatar URL (png, 256px recommended)
 * @param {string} opts.serverName - guild name
 * @param {number} opts.memberNumber - member count / join order
 * @param {string|null} opts.backgroundUrl - optional custom background image URL
 * @param {string} opts.accentColor - hex color for ring/badge accents, e.g. '#ec4899'
 */
export async function generateWelcomeCard({
    username,
    avatarUrl,
    serverName,
    memberNumber,
    backgroundUrl = null,
    accentColor = '#ec4899',
}) {
    const canvas = createCanvas(CARD_WIDTH, CARD_HEIGHT);
    const ctx = canvas.getContext('2d');

    // ── Background ──
    if (backgroundUrl) {
        try {
            const bgBuffer = await fetchImageBuffer(backgroundUrl);
            const bgImage = await loadImage(bgBuffer);
            // Cover-fit crop
            const scale = Math.max(CARD_WIDTH / bgImage.width, CARD_HEIGHT / bgImage.height);
            const w = bgImage.width * scale;
            const h = bgImage.height * scale;
            ctx.drawImage(bgImage, (CARD_WIDTH - w) / 2, (CARD_HEIGHT - h) / 2, w, h);

            // Dark overlay for text readability
            ctx.fillStyle = 'rgba(10, 5, 15, 0.45)';
            ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
        } catch (err) {
            logger.warn(`[WelcomeCard] Failed to load background image, using default: ${err.message}`);
            drawDefaultBackground(ctx);
        }
    } else {
        drawDefaultBackground(ctx);
    }

    // ── Member badge (top center) ──
    const badgeText = `Member #${memberNumber}`;
    ctx.font = `bold 22px ${FONT_FALLBACK}`;
    const badgeTextWidth = ctx.measureText(badgeText).width;
    const badgeWidth = badgeTextWidth + 50;
    const badgeX = (CARD_WIDTH - badgeWidth) / 2;
    const badgeY = 28;

    drawRoundedRect(ctx, badgeX, badgeY, badgeWidth, 44, 22);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fill();
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(badgeText, CARD_WIDTH / 2, badgeY + 22);

    // ── Avatar (circular, centered) ──
    const avatarX = (CARD_WIDTH - AVATAR_SIZE) / 2;
    const avatarY = 95;
    const avatarCenterX = avatarX + AVATAR_SIZE / 2;
    const avatarCenterY = avatarY + AVATAR_SIZE / 2;
    const avatarRadius = AVATAR_SIZE / 2;

    try {
        const avatarBuffer = await fetchImageBuffer(avatarUrl);
        const avatarImage = await loadImage(avatarBuffer);

        // Outer glow ring
        ctx.save();
        ctx.beginPath();
        ctx.arc(avatarCenterX, avatarCenterY, avatarRadius + 8, 0, Math.PI * 2);
        ctx.fillStyle = accentColor;
        ctx.shadowColor = accentColor;
        ctx.shadowBlur = 25;
        ctx.fill();
        ctx.restore();

        // Clip circle and draw avatar
        ctx.save();
        ctx.beginPath();
        ctx.arc(avatarCenterX, avatarCenterY, avatarRadius, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(avatarImage, avatarX, avatarY, AVATAR_SIZE, AVATAR_SIZE);
        ctx.restore();

        // Inner ring border
        ctx.beginPath();
        ctx.arc(avatarCenterX, avatarCenterY, avatarRadius, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 4;
        ctx.stroke();
    } catch (err) {
        logger.warn(`[WelcomeCard] Failed to load avatar: ${err.message}`);
        // Fallback: plain circle
        ctx.beginPath();
        ctx.arc(avatarCenterX, avatarCenterY, avatarRadius, 0, Math.PI * 2);
        ctx.fillStyle = '#444444';
        ctx.fill();
    }

    // ── Welcome text ──
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold 34px ${FONT_FALLBACK}`;
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 8;
    ctx.fillText(`Welcome ${truncate(normalizeText(username), 20)}`, CARD_WIDTH / 2, 300);

    ctx.font = `22px ${FONT_FALLBACK}`;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.shadowBlur = 4;
    ctx.fillText(`to ${truncate(normalizeText(serverName), 30)}`, CARD_WIDTH / 2, 332);

    return canvas.encode('png');
}

function truncate(str, max) {
    return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

/**
 * Converts "fancy text generator" Unicode letters (𝕫, 𝐚, ℤ, Ⓣ, Ｔ, etc.) to
 * plain ASCII so they render correctly on canvas — the bundled font only
 * has glyphs for standard Latin characters. Real CJK/emoji characters are
 * left as-is since they aren't decomposable this way.
 */
function normalizeText(str) {
    return str.normalize('NFKD');
}
