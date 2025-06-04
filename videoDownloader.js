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
    const { url, type, quality, platform } = req.body;
    
    if (!url || !type || !platform) {
        logger.warn(`Missing required fields from IP: ${req.ip}`);
        return res.status(400).json({ error: 'Thiếu thông tin cần thiết (url, type, platform)' });
    }

    try {
        await rateLimiter.consume(`download_${req.ip}`, 1);
        logger.info(`Download request: ${type} from ${platform}, URL: ${url}, IP: ${req.ip}`);

        if (platform === 'youtube') {
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

            let videoTitle = await getVideoTitle(videoId);
            if (!videoTitle || videoTitle.trim() === '') {
                videoTitle = `Video_YouTube_${videoId}`;
            }

            const fileExtension = type === 'video' ? 'mp4' : 'mp3';
            const sanitizedTitle = sanitizeFileName(videoTitle);
            const fileName = `${sanitizedTitle}${quality ? `_${quality}` : ''}.${fileExtension}`;
            const filePath = path.join(__dirname, 'downloads', fileName);

            // Tạo thư mục lưu trữ nếu chưa tồn tại
            if (!await fsPromises.access(path.join(__dirname, 'downloads')).then(() => true).catch(() => false)) {
                await fsPromises.mkdir(path.join(__dirname, 'downloads'), { recursive: true });
            }

            // Dọn dẹp thư mục downloads
            await cleanFolder(path.join(__dirname, 'downloads'));

            // Thử tải với yt-dlp trước
            try {
                const ytDlpOptions = [
                    url,
                    '--format', type === 'video' ? 'bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/best[ext=mp4]/best' : 'bestaudio[ext=m4a]/bestaudio/best',
                    '--merge-output-format', type === 'video' ? 'mp4' : 'mp3',
                    '--output', filePath,
                    '--no-check-certificates',
                    '--no-warnings',
                    '--prefer-free-formats',
                    '--add-header', 'referer:youtube.com',
                    '--add-header', 'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    '--add-header', 'accept-language:en-US,en;q=0.9',
                    '--add-header', 'sec-ch-ua:"Not_A Brand";v="8", "Chromium";v="120"',
                    '--add-header', 'sec-ch-ua-mobile:?0',
                    '--add-header', 'sec-ch-ua-platform:"Windows"',
                    '--concurrent', '4',
                    '--buffer-size', '1048576',
                    '--retries', '10',
                    '--fragment-retries', '10',
                    '--file-access-retries', '10',
                    '--max-filesize', '4G',
                    '--max-downloads', '1',
                    '--socket-timeout', '3000',
                    '--source-address', '0.0.0.0',
                    '--cookies-from-browser', 'chrome',
                    '--cookies-from-browser', 'firefox',
                    '--cookies-from-browser', 'edge',
                    '--cookies-from-browser', 'safari',
                    '--cookies-from-browser', 'opera',
                    '--cookies-from-browser', 'brave',
                    '--cookies-from-browser', 'chromium',
                    '--cookies-from-browser', 'vivaldi',
                    '--cookies-from-browser', 'whale'
                ];
                if (type === 'audio') {
                    ytDlpOptions.push('--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0');
                }

                await ytDlp.exec(ytDlpOptions);
                
                if (await validateFile(filePath)) {
                    return res.download(filePath, fileName, (err) => {
                        if (err) {
                            logger.error(`Lỗi khi gửi file ${fileName}: ${err.message}`);
                            if (!res.headersSent) {
                                res.status(500).json({ error: 'Lỗi khi gửi file' });
                            }
                        }
                        // Xóa file sau khi gửi
                        fsPromises.unlink(filePath).catch(err => logger.error(`Lỗi khi xóa file ${fileName}: ${err.message}`));
                    });
                }
            } catch (ytDlpError) {
                logger.error(`yt-dlp download failed: ${ytDlpError.message}`);
                if (ytDlpError.message && (ytDlpError.message.includes("Sign in to confirm you're not a bot") || ytDlpError.message.includes("Sign in to confirm you're not a bot"))) {
                    return res.status(403).json({ error: 'YouTube yêu cầu đăng nhập để xác nhận bạn không phải là bot. Vui lòng thử lại sau hoặc sử dụng cookies cá nhân.' });
                }
                // Thử phương pháp khác nếu yt-dlp thất bại
            }

            // Thử tải với @distube/ytdl-core
            try {
                const stream = ytdl(url, {
                    quality: type === 'video' ? 'highest' : 'highestaudio',
                    filter: type === 'video' ? 'videoandaudio' : 'audioonly',
                    requestOptions: {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                            'Accept-Language': 'en-US,en;q=0.5',
                            'Connection': 'keep-alive',
                            'Upgrade-Insecure-Requests': '1',
                            'Origin': 'https://www.youtube.com',
                            'Referer': 'https://www.youtube.com/'
                        }
                    }
                });

                const writeStream = fs.createWriteStream(filePath);
                stream.pipe(writeStream);

                return new Promise((resolve, reject) => {
                    writeStream.on('finish', () => {
                        if (validateFile(filePath)) {
                            res.download(filePath, fileName, (err) => {
                                if (err) {
                                    logger.error(`Lỗi khi gửi file ${fileName}: ${err.message}`);
                                    if (!res.headersSent) {
                                        res.status(500).json({ error: 'Lỗi khi gửi file' });
                                    }
                                }
                                fsPromises.unlink(filePath).catch(err => logger.error(`Lỗi khi xóa file ${fileName}: ${err.message}`));
                            });
                            resolve();
                        } else {
                            reject(new Error('File không hợp lệ sau khi tải'));
                        }
                    });

                    writeStream.on('error', (err) => {
                        logger.error(`Lỗi khi ghi file ${fileName}: ${err.message}`);
                        reject(err);
                    });
                });
            } catch (ytdlError) {
                logger.error(`@distube/ytdl-core download failed: ${ytdlError.message}`);
                throw new Error('Không thể tải nội dung từ bất kỳ nguồn nào');
            }
        } else {
            // Xử lý các nền tảng khác
            try {
                const response = await fetchWithRetry('https://all-media-downloader1.p.rapidapi.com/media', {
                    method: 'POST',
                    headers: {
                        'x-rapidapi-key': process.env.RAPIDAPI_KEY,
                        'x-rapidapi-host': 'all-media-downloader1.p.rapidapi.com',
                        'Content-Type': 'application/json'
                    },
                    data: { url, quality }
                });

                const data = response.data;
                if (data.error) {
                    logger.warn(`RapidAPI returned error: ${data.error}`);
                    return res.status(400).json({ error: data.error });
                }

                if (type === 'video' && data.video) {
                    return res.status(200).json({ downloadUrl: data.video });
                } else if (type === 'audio' && data.audio) {
                    return res.status(200).json({ downloadUrl: data.audio });
                } else {
                    logger.warn(`RapidAPI did not return expected content for type ${type}`);
                    return res.status(400).json({ error: 'Không tìm thấy nội dung để tải. API không trả về link tải.' });
                }
            } catch (rapidError) {
                logger.error(`RapidAPI Download Error: ${rapidError.message}`);
                return res.status(500).json({
                    error: rapidError.message || 'Lỗi từ RapidAPI. Vui lòng kiểm tra API key hoặc thử lại sau.'
                });
            }
        }
    } catch (error) {
        logger.error(`Download Error: ${error.message}`);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message || 'Lỗi khi tải nội dung' });
        }
    }
}

module.exports = {
    handleDownload
};