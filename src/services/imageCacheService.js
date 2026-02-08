/**
 * Image Cache Service
 * Handles caching of static images for FAST loading
 * 
 * Key feature: Caches Telegram file_id after first upload for instant subsequent sends
 * 
 * Usage:
 *   import imageCacheService from './services/imageCacheService.js';
 *   
 *   // Fast way - uses cached file_id if available
 *   const photo = await imageCacheService.getPhotoForTelegram(bot, 'IMG-3112.jpg');
 *   await bot.sendPhoto(chatId, photo, options);
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class ImageCacheService {
  constructor() {
    // Cache for image file paths and metadata
    this.imageCache = new Map();
    // Cache for Telegram file_ids (for instant re-sending)
    this.telegramFileIds = new Map();
    this.assetsPath = path.join(__dirname, '../assets');
    
    // Ensure assets directory exists
    if (!fs.existsSync(this.assetsPath)) {
      fs.mkdirSync(this.assetsPath, { recursive: true });
    }
    
    // Pre-load images on initialization
    this.preloadImages();
  }

  /**
   * Pre-load all images from assets directory into memory
   */
  preloadImages() {
    try {
      const files = fs.readdirSync(this.assetsPath);
      const imageFiles = files.filter(file => 
        /\.(jpg|jpeg|png|gif|webp)$/i.test(file)
      );
      
      console.log(`[IMAGE_CACHE] Pre-loading ${imageFiles.length} image(s) into memory...`);
      
      imageFiles.forEach(file => {
        const filePath = path.join(this.assetsPath, file);
        const stats = fs.statSync(filePath);
        
        // Read file into memory buffer for fast access
        const buffer = fs.readFileSync(filePath);
        
        this.imageCache.set(file, {
          path: filePath,
          buffer: buffer,
          size: stats.size,
          mtime: stats.mtime
        });
        
        console.log(`[IMAGE_CACHE] ✅ Loaded: ${file} (${(stats.size / 1024).toFixed(2)} KB)`);
      });
      
      console.log(`[IMAGE_CACHE] ✅ ${this.imageCache.size} image(s) ready in memory`);
    } catch (error) {
      console.error(`[IMAGE_CACHE] ⚠️ Error pre-loading images:`, error.message);
    }
  }

  /**
   * Get image data from cache
   * @param {string} imageRef - Image reference
   * @returns {Object|null} - Image data or null
   */
  getImageData(imageRef) {
    const cleanRef = imageRef.replace(/^@/, '');
    
    // Try exact match
    if (this.imageCache.has(cleanRef)) {
      return this.imageCache.get(cleanRef);
    }
    
    // Try with dash/underscore variants
    const withDash = cleanRef.replace(/_/g, '-');
    if (this.imageCache.has(withDash)) {
      return this.imageCache.get(withDash);
    }
    
    const withUnderscore = cleanRef.replace(/-/g, '_');
    if (this.imageCache.has(withUnderscore)) {
      return this.imageCache.get(withUnderscore);
    }
    
    return null;
  }

  /**
   * FAST: Get photo for Telegram - uses cached file_id if available
   * First send uploads the image, subsequent sends use file_id (instant)
   * 
   * @param {TelegramBot} bot - Telegram bot instance
   * @param {string} imageRef - Image reference (e.g., "IMG-3112.jpg")
   * @param {number} chatId - Optional chat ID for initial upload
   * @returns {Promise<string|Buffer>} - file_id (fast) or buffer (first time)
   */
  async getPhotoForTelegram(bot, imageRef, chatId = null) {
    const cleanRef = imageRef.replace(/^@/, '');
    
    // Check if we have a cached Telegram file_id (INSTANT)
    if (this.telegramFileIds.has(cleanRef)) {
      return this.telegramFileIds.get(cleanRef);
    }
    
    // Get image buffer from memory cache
    const imageData = this.getImageData(cleanRef);
    if (!imageData || !imageData.buffer) {
      return null;
    }
    
    // Return buffer - the caller will send it
    // We'll cache the file_id when setTelegramFileId is called after successful send
    return imageData.buffer;
  }

  /**
   * Cache the Telegram file_id after successful upload
   * Call this after bot.sendPhoto returns successfully
   * 
   * @param {string} imageRef - Image reference
   * @param {string} fileId - Telegram file_id from sent message
   */
  setTelegramFileId(imageRef, fileId) {
    const cleanRef = imageRef.replace(/^@/, '');
    this.telegramFileIds.set(cleanRef, fileId);
    
    // Also set for variants
    const withDash = cleanRef.replace(/_/g, '-');
    const withUnderscore = cleanRef.replace(/-/g, '_');
    this.telegramFileIds.set(withDash, fileId);
    this.telegramFileIds.set(withUnderscore, fileId);
    
    console.log(`[IMAGE_CACHE] ✅ Cached Telegram file_id for ${cleanRef} - future sends will be instant!`);
  }

  /**
   * Check if we have a cached Telegram file_id (for instant sending)
   * @param {string} imageRef - Image reference
   * @returns {string|null} - file_id or null
   */
  getTelegramFileId(imageRef) {
    const cleanRef = imageRef.replace(/^@/, '');
    return this.telegramFileIds.get(cleanRef) || null;
  }

  /**
   * Get image as buffer (from memory)
   * @param {string} imageRef - Image reference
   * @returns {Buffer|null}
   */
  getImageBuffer(imageRef) {
    const imageData = this.getImageData(imageRef);
    return imageData ? imageData.buffer : null;
  }

  /**
   * Check if image exists in cache
   * @param {string} imageRef - Image reference
   * @returns {boolean}
   */
  hasImage(imageRef) {
    return this.getImageData(imageRef) !== null;
  }

  /**
   * Legacy: Get image as file stream
   * @param {string} imageRef - Image reference
   * @returns {fs.ReadStream|null}
   */
  getImageStream(imageRef) {
    const imageData = this.getImageData(imageRef);
    if (!imageData || !imageData.path) {
      return null;
    }
    return fs.createReadStream(imageData.path);
  }

  /**
   * Get all cached image references
   * @returns {Array<string>}
   */
  listImages() {
    return Array.from(this.imageCache.keys());
  }
}

export default new ImageCacheService();
