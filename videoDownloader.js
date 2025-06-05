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

        // Kiểm tra FFmpeg
        const ffmpegAvailable = await checkFFmpeg();
        if (!ffmpegAvailable) {
            logger.error('FFmpeg is not installed or accessible');
            throw new Error('FFmpeg không được cài đặt hoặc không thể truy cập. Vui lòng cài FFmpeg theo hướng dẫn tại https://ffmpeg.org/download.html và thử lại. Nếu bạn đang dùng Windows, tải FFmpeg, giải nén, và thêm thư mục bin vào biến môi trường PATH.');
        }

        // Tạo ID tải xuống và lưu vào tiến trình
        const downloadId = uuidv4();
        downloadProgressMap.set(downloadId, { progress: 0, error: null });

        // Kiểm tra tính hợp lệ của URL YouTube
        const videoId = url.match(/[?&]v=([^&]+)/)?.[1] || url.match(/youtu\.be\/([^?&]+)/)?.[1];
        if (!videoId) {
            logger.warn(`Invalid YouTube URL from IP: ${req.ip}: ${url}`);
            throw new Error('URL YouTube không hợp lệ');
        }

        // Kiểm tra tính khả dụng của video
        const availability = await checkVideoAvailability(videoId);
        if (!availability.isAvailable) {
            logger.warn(`Video not available: ${videoId}, reason: ${availability.reason}`);
            throw new Error(availability.reason);
        }

        // Đảm bảo videoTitle luôn có giá trị hợp lệ
        let videoTitle = await getVideoTitle(videoId);
        if (!videoTitle || videoTitle.trim() === '') {
            videoTitle = `Video_YouTube_${videoId}`; // Fallback nếu không lấy được tiêu đề
        }

        const fileExtension = type === 'video' ? 'mp4' : 'mp3';
        const sanitizedTitle = sanitizeFileName(videoTitle);
        const fileName = `${sanitizedTitle}${quality ? `_${quality}` : ''}.${fileExtension}`;
        const filePath = path.join(DOWNLOAD_DIR, fileName);

        // Tạo thư mục lưu trữ nếu chưa tồn tại
        if (!await fsPromises.access(DOWNLOAD_DIR).then(() => true).catch(() => false)) {
            await fsPromises.mkdir(DOWNLOAD_DIR, { recursive: true });
        }

        // Dọn dẹp thư mục downloads
        await cleanFolder(DOWNLOAD_DIR);

        // Kiểm tra nếu file đã tồn tại
        if (await fsPromises.access(filePath).then(() => true).catch(() => false)) {
            const stats = await fsPromises.stat(filePath);
            if (stats.size === 0) {
                logger.error(`Existing file is empty: ${filePath}`);
                await fsPromises.unlink(filePath);
            } else {
                logger.info(`File đã tồn tại: ${filePath}`);
                const isValid = await validateFile(filePath, type);
                if (!isValid) {
                    logger.error(`File tồn tại nhưng không hợp lệ: ${filePath}`);
                    await fsPromises.unlink(filePath);
                } else {
                    downloadProgressMap.set(downloadId, { progress: 100, downloadUrl: `/downloads/${encodeURIComponent(fileName)}`, error: null });
                    return res.status(200).json({ success: true, downloadUrl: `/downloads/${encodeURIComponent(fileName)}` });
                }
            }
        }

        // Trả về ngay lập tức với downloadId để client theo dõi tiến trình
        res.status(200).json({ message: 'Đang tải, vui lòng chờ...', downloadId });

        // Tải file bất đồng bộ
        (async () => {
            try {
                let downloadedBytes = 0;
                let totalBytes = 0;

                // Phương pháp 1: Sử dụng yt-dlp để tải
                try {
                    const outputPath = path.join(DOWNLOAD_DIR, `${sanitizedTitle}${quality ? `_${quality}` : ''}`);
                    const options = type === 'video' ? {
                        format: 'bestvideo+bestaudio/best',
                        output: `${outputPath}.%(ext)s`,
                        mergeOutputFormat: 'mp4',
                        noCheckCertificates: true,
                        noWarnings: true,
                        preferFreeFormats: true,
                        addHeader: [
                            'referer:youtube.com',
                            'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                        ]
                    } : {
                        format: 'bestaudio',
                        extractAudio: true,
                        audioFormat: 'mp3',
                        output: `${outputPath}.%(ext)s`,
                        noCheckCertificates: true,
                        noWarnings: true,
                        preferFreeFormats: true,
                        addHeader: [
                            'referer:youtube.com',
                            'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                        ]
                    };

                    const command = ytDlp(url, options);
                    
                    command.on('progress', (progress) => {
                        if (progress.percent) {
                            const percent = Math.round(progress.percent);
                            downloadProgressMap.set(downloadId, {
                                progress: percent,
                                status: 'downloading',
                                error: null,
                                filePath: filePath
                            });
                            logger.info(`Download progress: ${percent}%`, {
                                videoId: url,
                                type: type,
                                downloadId: downloadId
                            });
                        }
                    });

                    command.on('end', async () => {
                        try {
                            // Check if file exists
                            if (!fs.existsSync(filePath)) {
                                const errorDetails = {
                                    url,
                                    type,
                                    filePath,
                                    downloadDir: DOWNLOAD_DIR,
                                    error: 'Không tìm thấy file sau khi tải. Có thể video không khả dụng hoặc bị chặn.'
                                };
                                logger.error(`File not found after download`, errorDetails);
                                downloadProgressMap.set(downloadId, {
                                    progress: 0,
                                    status: 'error',
                                    error: errorDetails.error,
                                    filePath: null
                                });
                                throw new Error(`Lỗi khi tải ${type}: ${errorDetails.error}\nChi tiết: ${JSON.stringify(errorDetails, null, 2)}`);
                            }
                            
                            // Check file size
                            const stats = fs.statSync(filePath);
                            if (stats.size === 0) {
                                const errorDetails = {
                                    url,
                                    type,
                                    filePath,
                                    fileSize: stats.size,
                                    error: 'File tải về trống hoặc không có nội dung'
                                };
                                logger.error(`Downloaded file is empty`, errorDetails);
                                downloadProgressMap.set(downloadId, {
                                    progress: 0,
                                    status: 'error',
                                    error: errorDetails.error,
                                    filePath: null
                                });
                                throw new Error(`Lỗi khi tải ${type}: ${errorDetails.error}\nChi tiết: ${JSON.stringify(errorDetails, null, 2)}`);
                            }
                            
                            // Cập nhật trạng thái hoàn thành
                            downloadProgressMap.set(downloadId, {
                                progress: 100,
                                status: 'completed',
                                error: null,
                                filePath: filePath
                            });

                            logger.info(`Successfully downloaded with yt-dlp: ${filePath}`, {
                                fileSize: stats.size,
                                type
                            });

                            res.json({ 
                                success: true, 
                                message: 'Tải xuống thành công',
                                filePath: filePath,
                                fileSize: stats.size,
                                downloadId
                            });
                        } catch (error) {
                            const errorDetails = {
                                url,
                                type,
                                filePath,
                                downloadDir: DOWNLOAD_DIR,
                                error: error.message,
                                stack: error.stack
                            };
                            logger.error(`Error processing downloaded file: ${error.message}`, errorDetails);
                            downloadProgressMap.set(downloadId, {
                                progress: 0,
                                status: 'error',
                                error: error.message,
                                filePath: null
                            });
                            throw error;
                        }
                    });

                    command.on('error', (error) => {
                        const errorDetails = {
                            url,
                            type,
                            filePath,
                            downloadDir: DOWNLOAD_DIR,
                            error: error.message,
                            stack: error.stack
                        };
                        logger.error(`Error in yt-dlp command: ${error.message}`, errorDetails);
                        downloadProgressMap.set(downloadId, {
                            progress: 0,
                            status: 'error',
                            error: error.message,
                            filePath: null
                        });
                        throw new Error(`Lỗi khi tải ${type}: ${error.message}\nChi tiết: ${JSON.stringify(errorDetails, null, 2)}`);
                    });

                } catch (error) {
                    const errorDetails = {
                        url,
                        type,
                        filePath,
                        downloadDir: DOWNLOAD_DIR,
                        error: error.message,
                        stack: error.stack
                    };
                    logger.error(`yt-dlp download failed: ${error.message}`, errorDetails);
                    // Tiếp tục với phương thức dự phòng
                }

            } catch (error) {
                logger.error(`Error in handleDownload: ${error.message}`);
                downloadProgressMap.set(downloadId, { progress: 0, error: error.message });
                throw error;
            }
        })();

    } catch (error) {
        logger.error(`Error in handleDownload: ${error.message}`);
        return res.status(500).json({ error: error.message });
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