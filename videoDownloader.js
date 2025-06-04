// videoDownloader.js
const { RateLimiterMemory } = require('rate-limiter-flexible');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const ytdl = require('@distube/ytdl-core');
const ytDlp = require('yt-dlp-exec');
const ffmpeg = require('fluent-ffmpeg');
const {
    logger,
    fetchWithRetry,
    checkFFmpeg,
    validateFile,
    cleanFolder,
    sanitizeFileName,
    checkVideoAvailability,
    getVideoTitle
} = require('./utils');

// Define download directory
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');

// Ensure download directory exists
async function ensureDownloadDir() {
    try {
        await fsPromises.access(DOWNLOAD_DIR);
    } catch (error) {
        await fsPromises.mkdir(DOWNLOAD_DIR, { recursive: true });
        logger.info(`Created download directory: ${DOWNLOAD_DIR}`);
    }
}

// Initialize download directory
ensureDownloadDir().catch(error => {
    logger.error(`Failed to create download directory: ${error.message}`);
});

// Rate Limiter: Giới hạn 50 request/phút cho endpoint tải video
const rateLimiter = new RateLimiterMemory({
    points: 50,
    duration: 60,
});

// Hàm kiểm tra danh sách định dạng để chọn định dạng khả dụng
async function getAvailableFormats(videoUrl) {
    logger.info(`Fetching formats for URL: ${videoUrl}`);
    try {
        const info = await ytdl.getInfo(videoUrl, { timeout: 30000 });
        const formats = info.formats;
        return formats.map(format => ({
            itag: format.itag,
            quality: format.qualityLabel || format.audioBitrate,
            container: format.container,
            type: format.mimeType.includes('video') ? 'video' : 'audio'
        }));
    } catch (error) {
        logger.error(`Error in getAvailableFormats with @distube/ytdl-core: ${error.message}`);
        return [];
    }
}

// Hàm chọn định dạng khả dụng dựa trên chất lượng và loại nội dung
async function selectAvailableFormat(videoUrl, quality, type) {
    const formats = await getAvailableFormats(videoUrl);
    if (formats.length === 0) return null;

    const qualityMap = {
        high: ['1080p', '720p'],
        medium: ['720p', '480p'],
        low: ['360p', '240p']
    };
    const preferredQualities = qualityMap[quality] || qualityMap['high'];

    for (let q of preferredQualities) {
        const format = formats.find(f => f.quality === q && f.type.includes(type));
        if (format) return format.itag;
    }

    if (type === 'video') {
        const videoFormat = formats.find(f => f.type.includes('video'));
        if (videoFormat) return videoFormat.itag;
    }

    const audioFormat = formats.find(f => f.type.includes('audio'));
    if (audioFormat) return audioFormat.itag;

    return formats[0]?.itag || null;
}

// Hàm xử lý tải video hoặc âm thanh
async function handleDownload(req, res, downloadProgressMap) {
    const { url, type, format, quality, language } = req.body;
    const ip = req.ip;
    
    logger.info(`Download request: ${type} from youtube, URL: ${url}, IP: ${ip}`);

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    try {
        // Ensure download directory exists
        await ensureDownloadDir();

        // Kiểm tra video có tồn tại không
        const videoInfo = await ytdl.getInfo(url, {
            timeout: 30000,
            requestOptions: {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': '*/*',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Origin': 'https://www.youtube.com',
                    'Referer': 'https://www.youtube.com/'
                }
            }
        });

        if (!videoInfo) {
            throw new Error('Không thể lấy thông tin video');
        }

        const videoTitle = videoInfo.videoDetails.title.replace(/[^\w\s-]/g, '_');
        const sanitizedTitle = videoTitle.replace(/\s+/g, '_');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const fileName = `${sanitizedTitle}_${quality}_${timestamp}`;
        const filePath = path.join(DOWNLOAD_DIR, `${fileName}.${type === 'video' ? 'mp4' : 'mp3'}`);

        // Tạo progress tracking
        const downloadId = `${type}_${Date.now()}`;
        downloadProgressMap.set(downloadId, {
            progress: 0,
            status: 'starting',
            error: null,
            filePath: null
        });

        // Thử tải bằng yt-dlp trước
        try {
            logger.info(`Attempting to download with yt-dlp: ${url}`);
            
            const ytDlpOptions = {
                format: 'bestaudio[ext=m4a]/bestaudio/best',
                extractAudio: true,
                audioFormat: 'mp3',
                audioQuality: 0,
                output: filePath,
                noCheckCertificates: true,
                noWarnings: true,
                preferFreeFormats: true,
                addHeader: [
                    'referer:youtube.com',
                    'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'accept-language:en-US,en;q=0.9',
                    'sec-ch-ua:"Not_A Brand";v="8", "Chromium";v="120"',
                    'sec-ch-ua-mobile:?0',
                    'sec-ch-ua-platform:"Windows"'
                ],
                concurrent: 4,
                bufferSize: 1048576,
                retries: 10,
                fragmentRetries: 10,
                fileAccessRetries: 10,
                maxFilesize: '4G',
                maxDownloads: 1,
                socketTimeout: 3000,
                sourceAddress: '0.0.0.0',
                cookiesFromBrowser: ['chrome', 'firefox', 'edge', 'opera', 'brave', 'chromium', 'vivaldi']
            };

            try {
                await ytDlp(url, ytDlpOptions);
                
                // Check if file exists
                if (!fs.existsSync(filePath)) {
                    throw new Error('File not found after download');
                }
                
                // Check file size
                const stats = fs.statSync(filePath);
                if (stats.size === 0) {
                    throw new Error('Downloaded file is empty');
                }
                
                logger.info(`Successfully downloaded with yt-dlp: ${filePath}`);
                return res.json({ 
                    success: true, 
                    message: 'Tải xuống thành công',
                    filePath: filePath
                });
            } catch (error) {
                logger.error(`Error in yt-dlp command: ${error.message}`, {
                    error: error.stack,
                    url: url,
                    type: type
                });
                throw new Error(`Lỗi khi tải ${type}: ${error.message}`);
            }
        } catch (error) {
            logger.error(`yt-dlp download failed: ${error.message}`, {
                error: error.stack,
                url: url,
                type: type
            });
            // Tiếp tục với phương thức dự phòng
        }

    } catch (error) {
        logger.error(`Error in handleDownload: ${error.message}`, {
            error: error.stack,
            url: url,
            type: type
        });
        res.status(500).json({ error: error.message });
    }
}

// Hàm gửi file
async function sendFile(req, res, filePath, fileName) {
    try {
        // Kiểm tra file tồn tại
        await fs.access(filePath);
        
        // Lấy thông tin file
        const stats = await fs.stat(filePath);
        const fileSize = stats.size;
        
        // Kiểm tra file size
        if (fileSize === 0) {
            throw new Error('File trống hoặc chưa được tải xong');
        }

        // Set headers
        res.setHeader('Content-Length', fileSize);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
        res.setHeader('Accept-Ranges', 'bytes');

        // Đọc và gửi file theo chunks
        const chunkSize = 1024 * 1024; // 1MB chunks
        const fileStream = fs.createReadStream(filePath, { highWaterMark: chunkSize });
        
        fileStream.on('error', (error) => {
            logger.error(`Error reading file: ${error.message}`, {
                error: error.stack,
                filePath: filePath
            });
            if (!res.headersSent) {
                res.status(500).json({ error: 'Lỗi khi đọc file' });
            }
        });

        fileStream.pipe(res);

        // Xử lý khi client ngắt kết nối
        req.on('close', () => {
            fileStream.destroy();
        });

    } catch (error) {
        logger.error(`Error sending file: ${error.message}`, {
            error: error.stack,
            filePath: filePath
        });
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        }
    }
}

module.exports = {
    handleDownload,
    sendFile,
    DOWNLOAD_DIR // Export DOWNLOAD_DIR for use in other modules
};