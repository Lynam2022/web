require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { RateLimiterMemory } = require('rate-limiter-flexible');
const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const ytdl = require('@distube/ytdl-core');
const rateLimit = require('express-rate-limit');
const winston = require('winston');
const os = require('os');
const { getSubtitles: getYTSubtitles } = require('@treeee/youtube-caption-extractor');
const ytDlp = require('yt-dlp-exec');
const ffmpeg = require('fluent-ffmpeg');
const { JSDOM } = require('jsdom');
const { handleDownload } = require('./videoDownloader');
const { handleDownloadSubtitle } = require('./subtitleDownloader');
const { 
    logger,
    fetchWithRetry,
    checkFFmpeg,
    validateFile,
    cleanFolder,
    sanitizeFileName,
    checkVideoAvailability,
    getVideoTitle,
    convertVttToSrt,
    convertXmlToVtt,
    truncateSubtitleText
} = require('./utils');

// Khởi tạo logger với winston
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json({
    limit: '10kb',
    verify: (req, res, buf) => {
        try {
            JSON.parse(buf);
        } catch (e) {
            res.status(400).json({ error: `Invalid JSON: ${e.message}` });
            throw new Error('Invalid JSON');
        }
    }
}));
app.use(express.static('public'));
app.use('/downloads', express.static(path.join(__dirname, 'downloads'), {
    maxAge: '1h',
    setHeaders: (res, path) => {
        res.set('Content-Disposition', 'attachment');
        res.set('Transfer-Encoding', 'chunked');
    }
}));

// Middleware xử lý CORS (giới hạn origin)
const allowedOrigins = ['http://localhost:3000', 'https://yourdomain.com'];
app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (allowedOrigins.includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin);
    }
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    next();
});

// Rate Limiter toàn cục
const globalRateLimiter = new RateLimiterMemory({
    points: 100,
    duration: 60,
});
app.use(async (req, res, next) => {
    try {
        await globalRateLimiter.consume(req.ip);
        next();
    } catch (error) {
        logger.warn(`Global rate limit exceeded for IP: ${req.ip}`);
        res.status(429).json({ error: 'Quá nhiều yêu cầu. Vui lòng thử lại sau!' });
    }
});

// Rate Limiter cho tải file
const downloadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5
});
app.use('/downloads', downloadLimiter);

// Rate Limiter: Giới hạn 50 request/phút cho endpoint tải video
const rateLimiter = new RateLimiterMemory({
    points: 50,
    duration: 60,
});

// Rate Limiter cho tải phụ đề: Giới hạn 5 request/giây
const subtitleRateLimiter = new RateLimiterMemory({
    points: 5,
    duration: 1,
});

// Tăng timeout cho các request
app.use((req, res, next) => {
    req.setTimeout(600000); // 10 phút
    res.setTimeout(600000);
    next();
});

// Hàm kiểm tra tính khả dụng của phụ đề
async function checkSubtitleAvailability(url, language) {
    try {
        const info = await ytdl.getInfo(url, { timeout: 30000 });
        const captions = info.player_response.captions;
        if (!captions || !captions.playerCaptionsTracklistRenderer) {
            return { available: false, reason: 'Video không có phụ đề nào' };
        }

        const captionTracks = captions.playerCaptionsTracklistRenderer.captionTracks || [];
        const translationLanguages = captions.playerCaptionsTracklistRenderer.translationLanguages || [];
        
        const hasManualSub = captionTracks.some(track => track.languageCode === language);
        const hasAutoSub = translationLanguages.some(tLang => tLang.languageCode === language);

        if (!hasManualSub && !hasAutoSub) {
            return { 
                available: false, 
                reason: `Không tìm thấy phụ đề cho ngôn ngữ ${language}`,
                availableLanguages: {
                    manual: captionTracks.map(track => track.languageCode),
                    auto: translationLanguages.map(tLang => tLang.languageCode)
                }
            };
        }

        return { 
            available: true,
            isAuto: !hasManualSub && hasAutoSub
        };
    } catch (error) {
        logger.error(`Error checking subtitle availability: ${error.message}`);
        return { available: false, reason: 'Không thể kiểm tra tính khả dụng của phụ đề' };
    }
}

// Hàm lấy thông tin video từ @distube/ytdl-core
async function getVideoInfo(url) {
    try {
        const info = await ytdl.getInfo(url, {
            requestOptions: {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                }
            }
        });
        return info;
    } catch (error) {
        logger.error(`Error getting video info: ${error.message}`, {
            error: error.stack,
            url: url
        });
        throw error;
    }
}

// Hàm tải phụ đề với @distube/ytdl-core
async function downloadSubtitleWithYtdlCore(url, language, isAuto = false) {
    try {
        const info = await getVideoInfo(url);
        const captions = info.player_response.captions;
        
        if (!captions || !captions.playerCaptionsTracklistRenderer) {
            throw new Error('Video không có phụ đề nào');
        }

        const captionTracks = captions.playerCaptionsTracklistRenderer.captionTracks || [];
        const translationLanguages = captions.playerCaptionsTracklistRenderer.translationLanguages || [];
        
        let subtitleUrl = null;
        let selectedTrack = null;

        if (!isAuto) {
            selectedTrack = captionTracks.find(track => track.languageCode === language);
            if (selectedTrack) {
                subtitleUrl = selectedTrack.baseUrl;
            }
        } else {
            // Thử tìm phụ đề tự động
            const autoTrack = captionTracks.find(track => track.kind === 'asr');
            if (autoTrack) {
                selectedTrack = autoTrack;
                subtitleUrl = `${autoTrack.baseUrl}&tlang=${language}`;
            } else {
                // Nếu không tìm thấy phụ đề tự động, thử dùng phụ đề thủ công
                const manualTrack = captionTracks[0];
                if (manualTrack) {
                    selectedTrack = manualTrack;
                    subtitleUrl = `${manualTrack.baseUrl}&tlang=${language}`;
                }
            }
        }

        if (!subtitleUrl) {
            throw new Error(`Không tìm thấy phụ đề cho ngôn ngữ ${language}`);
        }

        logger.info(`Downloading subtitle from URL: ${subtitleUrl}`, {
            language,
            isAuto,
            trackInfo: selectedTrack ? {
                languageCode: selectedTrack.languageCode,
                kind: selectedTrack.kind,
                name: selectedTrack.name?.simpleText
            } : null
        });

        // Thử tải phụ đề với retry
        let retries = 3;
        let lastError = null;
        let lastResponse = null;

        while (retries > 0) {
            try {
                const response = await axios.get(subtitleUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.5',
                        'Connection': 'keep-alive',
                        'Upgrade-Insecure-Requests': '1'
                    },
                    timeout: 30000
                });

                lastResponse = response;

                if (!response.data || response.data.trim() === '') {
                    throw new Error('Nội dung phụ đề trống từ server');
                }

                // Kiểm tra nếu là XML
                if (response.data.includes('<?xml') || response.data.includes('<transcript>')) {
                    const vttContent = convertXmlToVtt(response.data);
                    if (!vttContent) {
                        throw new Error('Không thể chuyển đổi XML sang VTT');
                    }
                    return vttContent;
                }

                // Kiểm tra nếu là VTT
                if (response.data.includes('WEBVTT')) {
                    return response.data;
                }

                // Nếu không phải XML hoặc VTT, thử chuyển đổi sang VTT
                try {
                    const vttContent = convertXmlToVtt(response.data);
                    if (vttContent) {
                        return vttContent;
                    }
                } catch (error) {
                    logger.warn(`Failed to convert content to VTT: ${error.message}`);
                }

                // Nếu không thể chuyển đổi, trả về nội dung gốc
                return response.data;
            } catch (error) {
                lastError = error;
                retries--;
                if (retries > 0) {
                    logger.warn(`Retrying subtitle download (${retries} attempts left): ${error.message}`, {
                        responseStatus: lastResponse?.status,
                        responseHeaders: lastResponse?.headers,
                        errorDetails: error.response?.data
                    });
                    await new Promise(resolve => setTimeout(resolve, 2000)); // Đợi 2 giây trước khi thử lại
                }
            }
        }

        // Log chi tiết lỗi cuối cùng
        logger.error('Subtitle download failed after all retries', {
            lastError: lastError?.message,
            responseStatus: lastResponse?.status,
            responseHeaders: lastResponse?.headers,
            errorDetails: lastError?.response?.data,
            url: subtitleUrl,
            language,
            isAuto
        });

        throw lastError || new Error('Không thể tải phụ đề sau nhiều lần thử');
    } catch (error) {
        logger.error(`Error downloading subtitle with ytdl-core: ${error.message}`, {
            error: error.stack,
            url: url,
            language: language,
            isAuto: isAuto
        });
        throw error;
    }
}

// Hàm tải video/âm thanh với @distube/ytdl-core
async function downloadMediaWithYtdlCore(url, type, quality) {
    try {
        // Nếu là audio, sử dụng yt-dlp trực tiếp
        if (type === 'audio') {
            logger.info('Using yt-dlp for audio download...');
            const tempDir = path.join(__dirname, 'temp');
            if (!await fsPromises.access(tempDir).then(() => true).catch(() => false)) {
                await fsPromises.mkdir(tempDir, { recursive: true });
            }

            const outputPath = path.join(tempDir, `${Date.now()}.mp3`);
            try {
                await ytDlp(url, {
                    extractAudio: true,
                    audioFormat: 'mp3',
                    audioQuality: 0, // Best quality
                    output: outputPath,
                    noCheckCertificates: true,
                    noWarnings: true,
                    preferFreeFormats: true,
                    addHeader: [
                        'referer:youtube.com',
                        'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                    ]
                });

                const fileStream = fs.createReadStream(outputPath);
                fileStream.on('end', () => {
                    fs.unlink(outputPath, () => {});
                });

                return { 
                    format: { 
                        container: 'mp3',
                        mimeType: 'audio/mp3',
                        hasAudio: true,
                        hasVideo: false,
                        quality: 'high'
                    }, 
                    stream: fileStream 
                };
            } catch (ytdlpError) {
                logger.error(`yt-dlp download failed: ${ytdlpError.message}`);
                throw ytdlpError;
            }
        }

        // Nếu là video, tiếp tục sử dụng ytdl-core
        // List of user agents to try
        const userAgents = [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.159 Safari/537.36',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:89.0) Gecko/20100101 Firefox/89.0',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Safari/605.1.15'
        ];

        let lastError = null;
        let selectedFormat = null;
        let info = null;
        let retryCount = 0;
        const maxRetries = 3;

        // Try each user agent with retries
        while (retryCount < maxRetries) {
            for (const userAgent of userAgents) {
                try {
                    info = await ytdl.getInfo(url, {
                        requestOptions: {
                            headers: {
                                'User-Agent': userAgent,
                                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                                'Accept-Language': 'en-US,en;q=0.5',
                                'Connection': 'keep-alive',
                                'Upgrade-Insecure-Requests': '1'
                            }
                        },
                        timeout: 30000
                    });
                    break; // If successful, break the loop
                } catch (error) {
                    lastError = error;
                    logger.warn(`Failed to get video info with user agent ${userAgent}: ${error.message}`);
                    await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second before retrying
                }
            }

            if (info) break; // If we got info, break the retry loop
            retryCount++;
            if (retryCount < maxRetries) {
                logger.info(`Retrying video info fetch (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, 2000 * retryCount)); // Exponential backoff
            }
        }

        if (!info) {
            throw new Error(`Failed to get video info after ${maxRetries} retries: ${lastError?.message}`);
        }

        const formats = info.formats;
        
        logger.info(`Available formats for ${url}:`, {
            totalFormats: formats.length,
            formats: formats.map(f => ({
                itag: f.itag,
                quality: f.qualityLabel || f.audioBitrate,
                container: f.container,
                hasVideo: f.hasVideo,
                hasAudio: f.hasAudio,
                mimeType: f.mimeType
            }))
        });

        // Định nghĩa các mức chất lượng
        const qualityMap = {
            high: ['1080p', '720p', '480p'],
            medium: ['720p', '480p', '360p'],
            low: ['480p', '360p', '240p']
        };
        const preferredQualities = qualityMap[quality] || qualityMap['high'];

        // Thử tìm định dạng phù hợp theo thứ tự ưu tiên
        for (const q of preferredQualities) {
            // Tìm định dạng có cả video và audio
            selectedFormat = formats.find(f => {
                const hasVideo = f.hasVideo;
                const hasAudio = f.hasAudio;
                const qualityMatch = f.qualityLabel === q;
                return hasVideo && hasAudio && qualityMatch;
            });

            if (selectedFormat) break;

            // Nếu không tìm thấy, thử tìm định dạng video có chất lượng phù hợp
            selectedFormat = formats.find(f => {
                const hasVideo = f.hasVideo;
                const qualityMatch = f.qualityLabel === q;
                return hasVideo && qualityMatch;
            });

            if (selectedFormat) break;
        }

        // Nếu vẫn không tìm thấy, lấy định dạng video đầu tiên
        if (!selectedFormat) {
            selectedFormat = formats.find(f => f.hasVideo);
        }

        if (!selectedFormat) {
            throw new Error(`Không tìm thấy định dạng phù hợp cho video. Vui lòng thử lại với chất lượng khác.`);
        }

        logger.info(`Selected format:`, {
            itag: selectedFormat.itag,
            quality: selectedFormat.qualityLabel || selectedFormat.audioBitrate,
            container: selectedFormat.container,
            hasVideo: selectedFormat.hasVideo,
            hasAudio: selectedFormat.hasAudio,
            mimeType: selectedFormat.mimeType
        });

        // Try downloading with different user agents and retries
        let lastDownloadError = null;
        retryCount = 0;

        while (retryCount < maxRetries) {
            for (const userAgent of userAgents) {
                try {
                    const options = {
                        quality: selectedFormat.itag,
                        requestOptions: {
                            headers: {
                                'User-Agent': userAgent,
                                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                                'Accept-Language': 'en-US,en;q=0.5',
                                'Connection': 'keep-alive',
                                'Upgrade-Insecure-Requests': '1',
                                'Origin': 'https://www.youtube.com',
                                'Referer': 'https://www.youtube.com/'
                            }
                        },
                        timeout: 60000 // Increase timeout to 60 seconds
                    };

                    const stream = ytdl(url, options);

                    // Add error handler for the stream
                    stream.on('error', (error) => {
                        logger.error(`Stream error: ${error.message}`, {
                            error: error.stack,
                            url: url,
                            type: type,
                            format: selectedFormat
                        });
                        throw error;
                    });

                    // Test the stream
                    await new Promise((resolve, reject) => {
                        const timeout = setTimeout(() => {
                            reject(new Error('Stream test timeout'));
                        }, 10000);

                        stream.on('error', (error) => {
                            clearTimeout(timeout);
                            reject(error);
                        });

                        stream.on('data', () => {
                            clearTimeout(timeout);
                            stream.removeAllListeners('error');
                            resolve();
                        });
                    });

                    return { format: selectedFormat, stream };
                } catch (error) {
                    lastDownloadError = error;
                    logger.warn(`Failed to download with user agent ${userAgent}: ${error.message}`);
                    await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second before retrying
                }
            }

            retryCount++;
            if (retryCount < maxRetries) {
                logger.info(`Retrying download (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, 2000 * retryCount)); // Exponential backoff
            }
        }

        throw new Error(`Failed to download after ${maxRetries} retries: ${lastDownloadError?.message}`);
    } catch (error) {
        logger.error(`Error downloading media: ${error.message}`, {
            error: error.stack,
            url: url,
            type: type,
            quality: quality
        });
        throw error;
    }
}

// Hàm chuyển đổi phụ đề sang VTT (chỉ giữ thời gian và văn bản)
function arrayToVtt(subtitles) {
    if (!subtitles || subtitles.length === 0) return null;
    let vtt = 'WEBVTT\n\n';
    subtitles.forEach((sub) => {
        const start = sub.startMs ? msToTime(sub.startMs) : msToTime(sub.start * 1000);
        const end = sub.startMs ? msToTime(sub.startMs + sub.durationMs) : msToTime(sub.end * 1000);
        const text = sub.subtitle || sub.text;
        if (text && text.trim()) {
            const truncatedText = truncateSubtitleText(text);
            vtt += `${start} --> ${end}\n${truncatedText}\n\n`;
        }
    });
    return vtt.trim() === 'WEBVTT' ? null : vtt.trim();
}

// Hàm chuyển đổi phụ đề sang SRT (chỉ giữ thời gian và văn bản, có số thứ tự)
function arrayToSrt(subtitles) {
    if (!subtitles || subtitles.length === 0) return null;
    let srt = '';
    subtitles.forEach((sub, index) => {
        const start = sub.startMs ? msToTimeSrt(sub.startMs) : msToTimeSrt(sub.start * 1000);
        const end = sub.startMs ? msToTimeSrt(sub.startMs + sub.durationMs) : msToTimeSrt(sub.end * 1000);
        const text = sub.subtitle || sub.text;
        if (text && text.trim()) {
            const truncatedText = truncateSubtitleText(text);
            srt += `${index + 1}\n${start} --> ${end}\n${truncatedText}\n\n`;
        }
    });
    return srt.trim() === '' ? null : srt.trim();
}

// Hàm chuyển đổi phụ đề sang TXT (chỉ văn bản, không thời gian)
function arrayToTxt(subtitles) {
    if (!subtitles || subtitles.length === 0) return null;
    const text = subtitles
        .filter(sub => (sub.subtitle || sub.text) && (sub.subtitle || sub.text).trim())
        .map(sub => truncateSubtitleText(sub.subtitle || sub.text))
        .join('\n\n');
    return text.trim() === '' ? null : text.trim();
}

// Hàm chuyển đổi thời gian từ milliseconds sang định dạng VTT
function msToTime(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const milliseconds = Math.floor((ms % 1000));
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(milliseconds, 3)}`;
}

// Hàm chuyển đổi thời gian từ milliseconds sang định dạng SRT
function msToTimeSrt(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const milliseconds = Math.floor((ms % 1000));
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(milliseconds, 3)}`;
}

// Hàm bổ sung số 0 cho định dạng thời gian
function pad(num, size = 2) {
    return num.toString().padStart(size, '0');
}

// Hàm chuyển đổi phụ đề sang định dạng khác
function convertSubtitleFormat(content, format) {
    if (!content || content.trim() === '') {
        logger.error('Empty subtitle content');
        return null;
    }

    try {
        switch (format.toLowerCase()) {
            case 'srt':
                return convertVttToSrt(content);
            case 'txt':
                return extractTextFromVtt(content);
            case 'vtt':
                return content.trim();
            default:
                logger.error(`Unsupported subtitle format: ${format}`);
                return null;
        }
    } catch (error) {
        logger.error(`Subtitle format conversion failed: ${error.message}`);
        return null;
    }
}

// Hàm lấy quốc gia từ IP
async function getCountryFromIP(ip) {
    try {
        const response = await fetchWithRetry(`http://ip-api.com/json/${ip}`, {});
        if (response.data.status !== 'success') {
            throw new Error('Không thể xác định quốc gia từ IP');
        }
        return response.data.countryCode; // Trả về mã quốc gia (ISO 3166-1 alpha-2)
    } catch (error) {
        logger.error(`Error fetching country from IP ${ip}: ${error.message}`);
        return 'DEFAULT'; // Mặc định nếu không xác định được quốc gia
    }
}

// Bảng ánh xạ quốc gia với ngôn ngữ phụ đề mặc định
const countryToLanguageMap = {
    "US": "en", "VN": "vi", "JP": "ja", "FR": "fr", "DE": "de", "CN": "zh", "IN": "hi",
    "BR": "pt", "RU": "ru", "KR": "ko", "CA": "en", "AU": "en", "GB": "en", "IT": "it",
    "ES": "es", "MX": "es", "TH": "th", "ID": "id", "PH": "tl", "MY": "ms", "SG": "en",
    "SA": "ar", "AE": "ar", "EG": "ar", "TR": "tr", "ZA": "en", "NG": "en", "KE": "en",
    "DEFAULT": "en"
};

// Hàm lấy ngôn ngữ mặc định dựa trên IP
async function getDefaultLanguage(ip) {
    const countryCode = await getCountryFromIP(ip);
    return countryToLanguageMap[countryCode] || countryToLanguageMap["DEFAULT"];
}

// Hàm lấy danh sách ngôn ngữ phụ đề từ @distube/ytdl-core
async function getAvailableSubtitleLanguages(url) {
    try {
        const info = await ytdl.getInfo(url, { timeout: 30000 });
        const captions = info.player_response.captions;
        if (!captions || !captions.playerCaptionsTracklistRenderer) {
            return { manual: [], auto: [] };
        }

        const captionTracks = captions.playerCaptionsTracklistRenderer.captionTracks || [];
        const manualLanguages = captionTracks.map(track => track.languageCode);

        const translationLanguages = captions.playerCaptionsTracklistRenderer.translationLanguages || [];
        const autoLanguages = translationLanguages.map(lang => lang.languageCode);

        return { manual: manualLanguages, auto: autoLanguages };
    } catch (ytdlError) {
        logger.error(`Error fetching subtitle languages with @distube/ytdl-core: ${ytdlError.message}`);
        // Fallback: Thử lấy danh sách ngôn ngữ từ yt-dlp
        try {
            const result = await ytDlp(url, {
                listSubs: true,
                skipDownload: true
            }, { stdio: 'pipe' });

            const lines = result.split('\n');
            const languages = { manual: [], auto: [] };

            for (const line of lines) {
                if (line.includes('Available subtitles for')) {
                    const langLines = lines.slice(lines.indexOf(line) + 1);
                    for (const langLine of langLines) {
                        if (langLine.trim() === '' || langLine.includes('Available automatic captions')) break;
                        const langCode = langLine.split(/\s+/)[0];
                        if (langCode) languages.manual.push(langCode);
                    }
                }
                if (line.includes('Available automatic captions for')) {
                    const autoLangLines = lines.slice(lines.indexOf(line) + 1);
                    for (const autoLangLine of autoLangLines) {
                        if (autoLangLine.trim() === '') break;
                        const langCode = autoLangLine.split(/\s+/)[0];
                        if (langCode) languages.auto.push(langCode);
                    }
                }
            }

            return languages;
        } catch (ytDlpError) {
            logger.error(`Error fetching subtitle languages with yt-dlp: ${ytDlpError.message}`);
            return { manual: [], auto: [] };
        }
    }
}

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

// Endpoint metadata
app.post('/api/metadata', async (req, res) => {
    if (!req.body || Object.keys(req.body).length === 0) {
        logger.warn(`Invalid request body from IP: ${req.ip}`);
        return res.status(400).json({ error: 'Body yêu cầu không hợp lệ hoặc thiếu dữ liệu. Vui lòng gửi JSON với các trường url và platform.' });
    }

    const { url, platform } = req.body;

    if (!url || !platform) {
        logger.warn(`Missing required fields (url, platform) from IP: ${req.ip}`);
        return res.status(400).json({ error: 'Thiếu thông tin cần thiết (url, platform)' });
    }

    try {
        let metadata = { thumbnail: '', title: '' };

        if (platform === 'youtube') {
            const videoId = url.match(/[?&]v=([^&]+)/)?.[1] || url.match(/youtu\.be\/([^?&]+)/)?.[1];
            if (videoId) {
                const youtubeResponse = await fetchWithRetry(`https://www.googleapis.com/youtube/v3/videos`, {
                    params: {
                        part: 'snippet',
                        id: videoId,
                        key: process.env.YOUTUBE_API_KEY
                    }
                });
                const item = youtubeResponse.data.items[0];
                if (item) {
                    metadata.thumbnail = item.snippet.thumbnails.high?.url || item.snippet.thumbnails.default?.url;
                    metadata.title = item.snippet.title || `Video YouTube mẫu - ${videoId}`;
                } else {
                    metadata.thumbnail = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
                    metadata.title = `Video YouTube mẫu - ${videoId}`;
                }
            } else {
                metadata.thumbnail = '';
                metadata.title = 'Video YouTube mẫu';
            }
        } else {
            try {
                const rapidApiResponse = await fetchWithRetry('https://all-media-downloader1.p.rapidapi.com/media', {
                    method: 'POST',
                    headers: {
                        'x-rapidapi-key': process.env.RAPIDAPI_KEY,
                        'x-rapidapi-host': 'all-media-downloader1.p.rapidapi.com',
                        'Content-Type': 'application/json'
                    },
                    data: { url }
                });
                const data = rapidApiResponse.data;
                if (data && data.metadata) {
                    metadata.thumbnail = data.metadata.thumbnail || '';
                    metadata.title = data.metadata.title || '';
                    if (!metadata.title) {
                        const titleMap = {
                            'tiktok': 'Video TikTok/Douyin mẫu',
                            'douyin': 'Video TikTok/Douyin mẫu',
                            'facebook': 'Video Facebook mẫu',
                            'instagram': 'Bài đăng Instagram mẫu',
                            'twitter': 'Tweet mẫu'
                        };
                        metadata.title = titleMap[platform] || 'Mẫu tiêu đề video';
                    }
                } else {
                    throw new Error('Metadata không hợp lệ từ RapidAPI');
                }
            } catch (rapidError) {
                logger.error(`RapidAPI Metadata Error: ${rapidError.message}`);
                const titleMap = {
                    'tiktok': 'Video TikTok/Douyin mẫu',
                    'douyin': 'Video TikTok/Douyin mẫu',
                    'facebook': 'Video Facebook mẫu',
                    'instagram': 'Bài đăng Instagram mẫu',
                    'twitter': 'Tweet mẫu'
                };
                metadata.title = titleMap[platform] || 'Mẫu tiêu đề video';
            }
        }

        res.json(metadata);
    } catch (error) {
        logger.error(`Metadata Error: ${error.message}`);
        const titleMap = {
            'youtube': 'Video YouTube mẫu',
            'tiktok': 'Video TikTok/Douyin mẫu',
            'douyin': 'Video TikTok/Douyin mẫu',
            'facebook': 'Video Facebook mẫu',
            'instagram': 'Bài đăng Instagram mẫu',
            'twitter': 'Tweet mẫu'
        };
        const fallbackTitle = titleMap[platform] || 'Mẫu tiêu đề video';
        res.status(500).json({ thumbnail: '', title: fallbackTitle });
    }
});

// Map để lưu trữ tiến trình tải
const downloadProgressMap = new Map();

// Endpoint theo dõi tiến trình tải
app.get('/api/download-progress/:downloadId', (req, res) => {
    const { downloadId } = req.params;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const sendProgress = () => {
        const progress = downloadProgressMap.get(downloadId);
        if (progress) {
            res.write(`data: ${JSON.stringify(progress)}\n\n`);
            if (progress.progress === 100 || progress.error) {
                downloadProgressMap.delete(downloadId);
                res.end();
            }
        }
    };

    // Gửi tiến trình ban đầu
    sendProgress();

    // Kiểm tra tiến trình mỗi 500ms
    const interval = setInterval(() => {
        if (!downloadProgressMap.has(downloadId)) {
            clearInterval(interval);
            res.end();
        } else {
            sendProgress();
        }
    }, 500);

    // Xử lý khi client ngắt kết nối
    req.on('close', () => {
        clearInterval(interval);
    });
});

// Sửa endpoint tải video/âm thanh
app.post('/api/download', async (req, res) => {
    try {
        await handleDownload(req, res, downloadProgressMap);
    } catch (error) {
        logger.error(`Download Error: ${error.message}`);
        res.status(500).json({ error: error.message || 'Lỗi server khi tải nội dung.' });
    }
});

// Sửa endpoint tải phụ đề
app.post('/api/download-subtitle', async (req, res) => {
    try {
        await handleDownloadSubtitle(req, res, downloadProgressMap);
    } catch (error) {
        logger.error(`Subtitle Download Error: ${error.message}`);
        res.status(500).json({ error: error.message || 'Lỗi server khi tải phụ đề.' });
    }
});

// Endpoint tải tất cả phụ đề (hỗ trợ phụ đề kép)
app.post('/api/download-all-subtitles', async (req, res) => {
    if (!req.body || Object.keys(req.body).length === 0) {
        logger.warn(`Invalid request body from IP: ${req.ip}`);
        return res.status(400).json({ error: 'Body yêu cầu không hợp lệ hoặc thiếu dữ liệu. Vui lòng gửi JSON với trường url.' });
    }

    const { url } = req.body;

    if (!url) {
        logger.warn(`Missing required field (url) from IP: ${req.ip}`);
        return res.status(400).json({ error: 'Thiếu thông tin cần thiết (url)' });
    }

    try {
        await subtitleRateLimiter.consume(`download_all_subtitles_${req.ip}`, 1);
        logger.info(`Download all subtitles request: URL: ${url}, IP: ${req.ip}`);

        const subtitlesDir = path.join(__dirname, 'subtitles');
        if (!await fsPromises.access(subtitlesDir).then(() => true).catch(() => false)) {
            await fsPromises.mkdir(subtitlesDir, { recursive: true });
        }

        await cleanFolder(subtitlesDir);

        const videoId = url.match(/[?&]v=([^&]+)/)?.[1] || url.match(/youtu\.be\/([^?&]+)/)?.[1];
        if (!videoId) {
            logger.warn(`Invalid YouTube URL from IP: ${req.ip}: ${url}`);
            return res.status(400).json({ error: 'URL YouTube không hợp lệ' });
        }

        const availability = await checkVideoAvailability(videoId);
        if (!availability.isAvailable) {
            logger.warn(`Video not available: ${videoId}, reason: ${availability.reason}`);
            return res.status(403).json({ error: availability.reason });
        }

        let subtitleFiles = [];
        let videoTitle = await getVideoTitle(videoId);

        // Lấy danh sách ngôn ngữ phụ đề từ @distube/ytdl-core
        const { manual: manualLanguages, auto: autoLanguages } = await getAvailableSubtitleLanguages(url);
        logger.info(`Available manual languages: ${manualLanguages.join(', ')}`);
        logger.info(`Available auto languages: ${autoLanguages.join(', ')}`);

        const allLanguages = [...new Set([...manualLanguages, ...autoLanguages])];

        if (allLanguages.length === 0) {
            throw new Error('Video không có phụ đề nào khả dụng.');
        }

        // Tải phụ đề từ tất cả ngôn ngữ
        const downloadPromises = allLanguages.map(async (lang) => {
            let subtitleContent = null;
            let selectedLang = lang;

            // Phương pháp 1: Sử dụng @distube/ytdl-core
            try {
                const info = await ytdl.getInfo(url, { timeout: 30000 });
                const captions = info.player_response.captions;
                if (!captions || !captions.playerCaptionsTracklistRenderer) {
                    throw new Error('Video không có phụ đề nào');
                }

                const captionTracks = captions.playerCaptionsTracklistRenderer.captionTracks || [];
                const translationLanguages = captions.playerCaptionsTracklistRenderer.translationLanguages || [];
                const caption = captionTracks.find(track => track.languageCode === lang);
                const autoLang = translationLanguages.find(tLang => tLang.languageCode === lang);

                if (caption) {
                    const captionUrl = caption.baseUrl;
                    const response = await fetchWithRetry(captionUrl, { responseType: 'text' }, 3, 2000);
                    subtitleContent = response.data;
                    selectedLang = lang;
                } else if (autoLang && captionTracks[0]) {
                    const autoCaptionUrl = `${captionTracks[0]?.baseUrl}&tlang=${lang}`;
                    const response = await fetchWithRetry(autoCaptionUrl, { responseType: 'text' }, 3, 2000);
                    subtitleContent = response.data;
                    selectedLang = `${lang}.auto`;
                } else {
                    throw new Error(`Không tìm thấy phụ đề cho ngôn ngữ ${lang}.`);
                }

                if (!subtitleContent || subtitleContent.trim() === '') {
                    throw new Error(`Nội dung phụ đề rỗng từ @distube/ytdl-core cho ngôn ngữ ${lang}.`);
                }
            } catch (ytdlError) {
                logger.error(`@distube/ytdl-core subtitle download failed for lang ${lang}: ${ytdlError.message}`);
            }

            // Phương pháp 2: Sử dụng yt-dlp (dự phòng)
            if (!subtitleContent) {
                try {
                    const tempDir = path.join(__dirname, 'temp');
                    if (!await fsPromises.access(tempDir).then(() => true).catch(() => false)) {
                        await fsPromises.mkdir(tempDir, { recursive: true });
                    }

                    const outputPath = path.join(tempDir, `${videoTitle}.${lang}.vtt`);
                    if (manualLanguages.includes(lang)) {
                        await ytDlp(url, {
                            skipDownload: true,
                            writeSub: true,
                            subLang: lang,
                            subFormat: 'vtt',
                            output: outputPath
                        });
                    } else {
                        await ytDlp(url, {
                            skipDownload: true,
                            writeAutoSub: true,
                            subLang: lang,
                            subFormat: 'vtt',
                            output: outputPath
                        });
                        selectedLang = `${lang}.auto`;
                    }

                    if (await fsPromises.access(outputPath).then(() => true).catch(() => false)) {
                        subtitleContent = await fsPromises.readFile(outputPath, 'utf8');
                        await fsPromises.unlink(outputPath);
                    } else {
                        throw new Error(`Không tìm thấy file phụ đề sau khi tải từ yt-dlp cho ngôn ngữ ${lang}.`);
                    }
                } catch (ytdlpError) {
                    logger.error(`yt-dlp subtitle download failed for lang ${lang}: ${ytdlpError.message}`);
                }
            }

            // Phương pháp 3: Sử dụng youtube-caption-extractor (dự phòng)
            if (!subtitleContent) {
                try {
                    let subtitles = await getYTSubtitles({ videoId, lang });
                    if (!subtitles || subtitles.length === 0) {
                        subtitles = await getYTSubtitles({ videoId, lang, tlang: lang });
                        if (!subtitles || subtitles.length === 0) {
                            throw new Error(`Danh sách phụ đề rỗng từ youtube-caption-extractor cho ngôn ngữ ${lang}.`);
                        }
                        selectedLang = `${lang}.auto`;
                    }
                    subtitleContent = arrayToVtt(subtitles);
                } catch (ytError) {
                    logger.error(`youtube-caption-extractor Error for lang ${lang}: ${ytError.message}`);
                    return [];
                }
            }

            if (!subtitleContent || subtitleContent.trim() === '') return [];

            const formats = ['srt', 'vtt', 'txt'];
            const formatPromises = formats.map(async (format) => {
                let content = subtitleContent;
                if (format === 'txt') {
                    content = extractTextFromVtt(content);
                } else if (format === 'srt') {
                    content = convertVttToSrt(content);
                }
                if (!content || content.trim() === '') return null;

                const fileName = `${videoTitle}_${selectedLang}.${format}`;
                const filePath = path.join(subtitlesDir, fileName);
                await fsPromises.writeFile(filePath, content);
                return { language: selectedLang, format, downloadUrl: `/subtitles/${encodeURIComponent(fileName)}` };
            });

            return (await Promise.all(formatPromises)).filter(item => item !== null);
        });

        const results = await Promise.all(downloadPromises);
        subtitleFiles = results.flat();

        if (subtitleFiles.length === 0) {
            throw new Error('Không thể tải phụ đề từ bất kỳ nguồn nào. Video có thể không có phụ đề hoặc không hỗ trợ ngôn ngữ yêu cầu.');
        }

        res.status(200).json({ success: true, subtitles: subtitleFiles });
    } catch (error) {
        logger.error(`Download All Subtitles Error: ${error.message}`);
        return res.status(500).json({ error: error.message || 'Lỗi server khi tải phụ đề. Vui lòng thử lại sau!' });
    }
});

// Endpoint tải phụ đề (GET) - Thông báo lỗi
app.get('/api/download-subtitle', (req, res) => {
    logger.warn(`Invalid method GET for /api/download-subtitle from IP: ${req.ip}`);
    res.status(405).json({ error: 'Phương thức không được hỗ trợ. Vui lòng sử dụng POST để gửi yêu cầu tới /api/download-subtitle với body chứa url, platform, targetLanguage (tùy chọn), và formatPreference (tùy chọn "srt", "vtt", "txt").' });
});

// Endpoint tải tất cả phụ đề (GET) - Thông báo lỗi
app.get('/api/download-all-subtitles', (req, res) => {
    logger.warn(`Invalid method GET for /api/download-all-subtitles from IP: ${req.ip}`);
    res.status(405).json({ error: 'Phương thức không được hỗ trợ. Vui lòng sử dụng POST để gửi yêu cầu tới /api/download-all-subtitles với body chứa url.' });
});

// Cung cấp file phụ đề
app.get('/subtitles/:file', async (req, res) => {
    const fileName = decodeURIComponent(req.params.file);
    const filePath = path.join(__dirname, 'subtitles', fileName);
    logger.info(`Yêu cầu tải phụ đề: ${filePath}`);
    try {
        await fsPromises.access(filePath);
        const stats = await fsPromises.stat(filePath);
        if (stats.size === 0) {
            logger.error(`File phụ đề rỗng: ${filePath}`);
            await fsPromises.unlink(filePath);
            if (!res.headersSent) {
                return res.status(500).json({ error: 'File phụ đề rỗng. Vui lòng thử lại.' });
            }
        }

        // Thiết lập headers cho download phụ đề
        res.set({
            'Content-Type': 'text/plain',
            'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`,
            'Content-Length': stats.size,
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });

        // Tạo read stream với error handling
        const fileStream = fs.createReadStream(filePath);
        
        fileStream.on('error', (error) => {
            logger.error(`Lỗi đọc file phụ đề ${fileName}: ${error.message}`);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Lỗi tải phụ đề' });
            }
        });

        // Xử lý khi client ngắt kết nối
        req.on('close', () => {
            fileStream.destroy();
            logger.info(`Client ngắt kết nối khi tải phụ đề ${fileName}`);
        });

        // Pipe file stream tới response
        fileStream.pipe(res);

    } catch (error) {
        logger.error(`File phụ đề không tìm thấy: ${filePath}`);
        if (!res.headersSent) {
            res.status(404).json({ error: 'File không tìm thấy' });
        }
    }
});

// Cung cấp file tải về (video/âm thanh)
app.get('/downloads/:file', async (req, res) => {
    try {
        const fileName = decodeURIComponent(req.params.file);
        const filePath = path.join(__dirname, 'downloads', fileName);
        logger.info(`Yêu cầu tải file: ${filePath}`);

        await fsPromises.access(filePath);
        const stats = await fsPromises.stat(filePath);
        if (stats.size === 0) {
            logger.error(`File tải về rỗng: ${filePath}`);
            await fsPromises.unlink(filePath);
            if (!res.headersSent) {
                return res.status(500).json({ error: 'Lỗi tải file' });
            }
        }

        // Thiết lập headers cho download
        res.set({
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`,
            'Content-Length': stats.size,
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });

        // Tạo read stream với error handling
        const fileStream = fs.createReadStream(filePath);
        
        fileStream.on('error', (error) => {
            logger.error(`Lỗi đọc file ${fileName}: ${error.message}`);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Lỗi tải file' });
            }
        });

        // Xử lý khi client ngắt kết nối
        req.on('close', () => {
            fileStream.destroy();
            logger.info(`Client ngắt kết nối khi tải file ${fileName}`);
        });

        // Pipe file stream tới response
        fileStream.pipe(res);

    } catch (error) {
        logger.error(`File không tìm thấy: ${error.message}`);
        if (!res.headersSent) {
            res.status(404).json({ error: 'File không tìm thấy' });
        }
    }
});

app.listen(port, () => {
    logger.info(`Server running on port ${port}, OS: ${os.platform()}, Node.js version: ${process.version}`);
});