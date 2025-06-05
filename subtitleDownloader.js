// subtitleDownloader.js
const { RateLimiterMemory } = require('rate-limiter-flexible');
const fsPromises = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const ytdl = require('@distube/ytdl-core');
const ytDlp = require('yt-dlp-exec');
const {
    logger,
    fetchWithRetry,
    cleanFolder,
    sanitizeFileName,
    getVideoTitle,
    arrayToVtt,
    convertVttToSrt,
    extractTextFromVtt,
    getAvailableSubtitleLanguages,
    checkVideoAvailability,
    getDefaultLanguage
} = require('./utils');
const { JSDOM } = require('jsdom');

// Rate Limiter cho tải phụ đề: Giới hạn 5 request/giây
const subtitleRateLimiter = new RateLimiterMemory({
    points: 5,
    duration: 1,
});

// Danh sách để theo dõi các yêu cầu tải phụ đề đang xử lý
const activeSubtitleRequests = new Map();

// Hàm làm sạch nội dung phụ đề
function cleanSubtitleContent(content) {
    if (!content || content.trim() === '') {
        logger.error('Empty content input for cleaning');
        return null;
    }

    try {
        // Loại bỏ các thẻ HTML/XML nhưng giữ nội dung bên trong
        let cleanedContent = content
            .replace(/<[^>]+>/g, '') // Loại bỏ thẻ HTML
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/\u200B/g, '') // Loại bỏ zero-width space
            .replace(/\u200C/g, '') // Loại bỏ zero-width non-joiner
            .replace(/\u200D/g, '') // Loại bỏ zero-width joiner
            .replace(/\u200E/g, '') // Loại bỏ left-to-right mark
            .replace(/\u200F/g, ''); // Loại bỏ right-to-left mark

        // Loại bỏ các ký tự điều khiển nhưng giữ Unicode
        cleanedContent = cleanedContent.replace(/[\x00-\x1F\x7F-\x9F]/g, '');

        // Loại bỏ các định dạng đặc biệt
        cleanedContent = cleanedContent
            .replace(/align:start/g, '')
            .replace(/position:\d+%/g, '')
            .replace(/<c>/g, '')
            .replace(/<\/c>/g, '');

        // Giữ lại các dòng timestamp và nội dung phụ đề
        const lines = cleanedContent.split('\n');
        const validLines = lines.filter(line => {
            const trimmedLine = line.trim();
            if (!trimmedLine) return false;

            // Kiểm tra timestamp
            if (trimmedLine.match(/\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}/)) {
                return true;
            }

            // Kiểm tra nội dung phụ đề có chứa ký tự hợp lệ không
            // Mở rộng phạm vi ký tự hợp lệ để bao gồm nhiều ngôn ngữ hơn
            return /[\p{L}\p{N}\p{P}\p{Z}\p{S}\p{M}]/u.test(trimmedLine);
        });

        cleanedContent = validLines.join('\n').trim();

        // Kiểm tra xem nội dung sau khi làm sạch có hợp lệ không
        if (!cleanedContent) {
            logger.error('No valid content after cleaning');
            logger.debug('Original content:', content);
            return null;
        }

        // Kiểm tra xem có ít nhất một dòng nội dung phụ đề không
        const hasContent = validLines.some(line => 
            !line.match(/\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}/) &&
            /[\p{L}\p{N}\p{P}\p{Z}\p{S}\p{M}]/u.test(line)
        );

        if (!hasContent) {
            logger.error('No valid subtitle text content found');
            logger.debug('Cleaned content:', cleanedContent);
            return null;
        }

        // Đảm bảo định dạng VTT hợp lệ
        if (!cleanedContent.startsWith('WEBVTT')) {
            cleanedContent = 'WEBVTT\n\n' + cleanedContent;
        }

        // Đảm bảo có khoảng trắng giữa các phần tử
        cleanedContent = cleanedContent
            .replace(/(\d{2}:\d{2}:\d{2}\.\d{3})-->/g, '$1 -->')
            .replace(/(\d{2}:\d{2}:\d{2}\.\d{3})-->/g, '$1 -->');

        return cleanedContent;
    } catch (error) {
        logger.error(`Error cleaning subtitle content: ${error.message}`);
        logger.debug('Original content:', content);
        return null;
    }
}

// Hàm kiểm tra ngôn ngữ phụ đề
function detectSubtitleLanguage(content) {
    if (!content) return null;
    
    // Danh sách các ký tự đặc trưng cho các ngôn ngữ
    const languagePatterns = {
        'vi': /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i,
        'zh': /[\u4e00-\u9fff]/,
        'ja': /[\u3040-\u309f\u30a0-\u30ff]/,
        'ko': /[\uac00-\ud7af\u1100-\u11ff]/,
        'th': /[\u0e00-\u0e7f]/,
        'ar': /[\u0600-\u06ff]/,
        'ru': /[\u0400-\u04ff]/,
        'en': /^[a-zA-Z\s.,!?'"-]+$/
    };

    for (const [lang, pattern] of Object.entries(languagePatterns)) {
        if (pattern.test(content)) {
            return lang;
        }
    }
    
    return null;
}

// Hàm tải phụ đề bằng yt-dlp với kiểm tra ngôn ngữ
async function downloadSubtitleWithYtDlp(url, language, outputPath) {
    try {
        const options = {
            skipDownload: true,
            writeSub: true,
            subLang: language,
            subFormat: 'vtt',
            output: outputPath,
            noCheckCertificates: true,
            noWarnings: true,
            preferFreeFormats: true,
            addHeader: [
                'referer:youtube.com',
                'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            ]
        };

        await ytDlp(url, options);
        return true;
    } catch (error) {
        logger.error(`yt-dlp subtitle download failed: ${error.message}`);
        return false;
    }
}

// Hàm tải phụ đề bằng @distube/ytdl-core với kiểm tra ngôn ngữ
async function downloadSubtitleWithYtdlCore(videoId, language) {
    try {
        const info = await ytdl.getInfo(videoId, { 
            timeout: 30000,
            requestOptions: {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    'Accept': '*/*',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Range': 'bytes=0-'
                }
            }
        });
        const captions = info.player_response.captions;
        
        if (!captions || !captions.playerCaptionsTracklistRenderer) {
            throw new Error('Video không có phụ đề nào');
        }

        const captionTracks = captions.playerCaptionsTracklistRenderer.captionTracks || [];
        const translationLanguages = captions.playerCaptionsTracklistRenderer.translationLanguages || [];
        
        let subtitleUrl = null;
        let selectedTrack = null;

        // Thử tìm phụ đề thủ công trước
        const manualTrack = captionTracks.find(track => track.languageCode === language);
        if (manualTrack) {
            selectedTrack = manualTrack;
            subtitleUrl = manualTrack.baseUrl;
            logger.info(`Found manual subtitle for ${language}`);
        } else {
            // Nếu không có phụ đề thủ công, thử tìm phụ đề tự động
            logger.info(`Manual subtitle not found for ${language}, trying auto-generated subtitles...`);
            const autoTrack = captionTracks.find(track => track.kind === 'asr');
            if (autoTrack) {
                selectedTrack = autoTrack;
                subtitleUrl = `${autoTrack.baseUrl}&tlang=${language}`;
                logger.info(`Found auto-generated subtitle for ${language}`);
            } else {
                // Nếu không tìm thấy phụ đề tự động, thử dùng phụ đề thủ công đầu tiên và dịch
                const firstManualTrack = captionTracks[0];
                if (firstManualTrack) {
                    selectedTrack = firstManualTrack;
                    subtitleUrl = `${firstManualTrack.baseUrl}&tlang=${language}`;
                    logger.info(`Using first manual track and translating to ${language}`);
                }
            }
        }

        if (!subtitleUrl) {
            throw new Error(`Không tìm thấy phụ đề cho ngôn ngữ ${language}`);
        }

        logger.info(`Downloading subtitle from URL: ${subtitleUrl}`, {
            language,
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
                const response = await fetchWithRetry(subtitleUrl, { 
                    responseType: 'text',
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.5',
                        'Connection': 'keep-alive',
                        'Upgrade-Insecure-Requests': '1'
                    }
                }, 3, 2000);

                lastResponse = response;

                if (!response.data || response.data.trim() === '') {
                    // Thử tải lại với URL khác nếu nội dung trống
                    if (selectedTrack && selectedTrack.kind === 'asr') {
                        // Thử tải phụ đề thủ công thay vì tự động
                        const manualTrack = captionTracks.find(track => track.kind !== 'asr');
                        if (manualTrack) {
                            subtitleUrl = `${manualTrack.baseUrl}&tlang=${language}`;
                            selectedTrack = manualTrack;
                            logger.info(`Retrying with manual track for ${language}`);
                            continue;
                        }
                    }
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
            language
        });

        throw lastError || new Error('Không thể tải phụ đề sau nhiều lần thử');
    } catch (error) {
        logger.error(`Error downloading subtitle with ytdl-core: ${error.message}`, {
            error: error.stack,
            videoId: videoId,
            language: language
        });
        throw error;
    }
}

// Hàm tải phụ đề bằng node-youtube-subtitles
async function downloadSubtitleWithNodeSubtitles(videoId, language) {
    try {
        const { getSubtitles } = require('node-youtube-subtitles');
        
        // Thử tải phụ đề thủ công trước
        let subtitles = await getSubtitles({ 
            videoID: videoId, 
            lang: language 
        });

        // Nếu không có phụ đề thủ công, thử tải phụ đề tự động
        if (!subtitles || subtitles.length === 0) {
            subtitles = await getSubtitles({ 
                videoID: videoId, 
                lang: `${language}.auto` 
            });
        }

        // Nếu vẫn không có, thử tải phụ đề tiếng Anh làm fallback
        if (!subtitles || subtitles.length === 0) {
            subtitles = await getSubtitles({ 
                videoID: videoId, 
                lang: 'en' 
            });
        }

        if (subtitles && subtitles.length > 0) {
            const content = arrayToVtt(subtitles);
            if (!content || content.trim() === '') {
                logger.warn(`Empty subtitle content from node-youtube-subtitles for language ${language}`);
                return null;
            }

            // Kiểm tra và làm sạch nội dung
            const cleanedContent = cleanSubtitleContent(content);
            if (!cleanedContent) {
                logger.warn(`Failed to clean subtitle content from node-youtube-subtitles for language ${language}`);
                return null;
            }

            return content;
        }

        logger.warn(`No subtitles found with node-youtube-subtitles for language ${language}`);
        return null;
    } catch (error) {
        logger.error(`node-youtube-subtitles Error for language ${language}: ${error.message}`);
        return null;
    }
}

// Hàm tải phụ đề bằng YouTube API
async function downloadSubtitleWithYouTubeAPI(videoId, language) {
    try {
        // Thử tải phụ đề thủ công trước
        const manualUrl = `https://www.youtube.com/api/timedtext?lang=${language}&v=${videoId}`;
        const manualResponse = await fetchWithRetry(manualUrl, { 
            responseType: 'text',
            timeout: 10000,
            retries: 3,
            delay: 1000
        });

        if (manualResponse && manualResponse.data) {
            const content = manualResponse.data;
            if (content && content.trim() !== '') {
                return content;
            }
        }

        // Nếu không có phụ đề thủ công, thử tải phụ đề tự động
        const autoUrl = `https://www.youtube.com/api/timedtext?lang=${language}&tlang=${language}&v=${videoId}`;
        const autoResponse = await fetchWithRetry(autoUrl, { 
            responseType: 'text',
            timeout: 10000,
            retries: 3,
            delay: 1000
        });

        if (autoResponse && autoResponse.data) {
            const content = autoResponse.data;
            if (content && content.trim() !== '') {
                return content;
            }
        }

        // Nếu vẫn không có, thử tải phụ đề tiếng Anh làm fallback
        const enUrl = `https://www.youtube.com/api/timedtext?lang=en&v=${videoId}`;
        const enResponse = await fetchWithRetry(enUrl, { 
            responseType: 'text',
            timeout: 10000,
            retries: 3,
            delay: 1000
        });

        if (enResponse && enResponse.data) {
            const content = enResponse.data;
            if (content && content.trim() !== '') {
                logger.info(`Using English subtitles as fallback for ${language}`);
                return content;
            }
        }

        logger.warn(`No subtitles found with YouTube API for language ${language}`);
        return null;
    } catch (error) {
        logger.error(`YouTube API subtitle download failed for language ${language}: ${error.message}`);
        return null;
    }
}

// Hàm chuyển đổi định dạng phụ đề
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

// Hàm xử lý tải phụ đề
async function handleDownloadSubtitle(req, res, downloadProgressMap) {
    const { url, platform, targetLanguage, formatPreference } = req.body;

    if (!url || !platform) {
        logger.warn(`Missing required fields (url, platform) from IP: ${req.ip}`);
        return res.status(400).json({ error: 'Thiếu thông tin cần thiết (url, platform)' });
    }

    try {
        const downloadId = uuidv4();
        downloadProgressMap.set(downloadId, { progress: 0, error: null });

        if (platform === 'youtube') {
            const videoId = url.match(/[?&]v=([^&]+)/)?.[1] || url.match(/youtu\.be\/([^?&]+)/)?.[1];
            if (!videoId) {
                throw new Error('URL YouTube không hợp lệ');
            }

            const availability = await checkVideoAvailability(videoId);
            if (!availability.isAvailable) {
                throw new Error(availability.reason);
            }

            let videoTitle = await getVideoTitle(videoId);
            if (!videoTitle || videoTitle.trim() === '') {
                videoTitle = `Video_YouTube_${videoId}`;
            }

            const language = targetLanguage || await getDefaultLanguage();
            const format = formatPreference || 'vtt';
            const sanitizedTitle = sanitizeFileName(videoTitle);
            const fileName = `${sanitizedTitle}_${language}.${format}`;
            const filePath = path.join(__dirname, 'subtitles', fileName);

            if (!await fsPromises.access(path.join(__dirname, 'subtitles')).then(() => true).catch(() => false)) {
                await fsPromises.mkdir(path.join(__dirname, 'subtitles'), { recursive: true });
            }

            await cleanFolder(path.join(__dirname, 'subtitles'));

            res.status(200).json({ message: 'Đang tải, vui lòng chờ...', downloadId });

            (async () => {
                try {
                    let subtitleContent = null;
                    let success = false;

                    // Ensure temp directory exists before using it
                    const tempDir = path.join(__dirname, 'temp');
                    if (!await fsPromises.access(tempDir).then(() => true).catch(() => false)) {
                        await fsPromises.mkdir(tempDir, { recursive: true });
                    }

                    // Try yt-dlp first
                    const tempPath = path.join(tempDir, `${sanitizedTitle}.${language}.vtt`);
                    success = await downloadSubtitleWithYtDlp(url, language, tempPath);
                    if (success && await fsPromises.access(tempPath).then(() => true).catch(() => false)) {
                        subtitleContent = await fsPromises.readFile(tempPath, 'utf8');
                        await fsPromises.unlink(tempPath);
                    }

                    // If yt-dlp fails, try ytdl-core
                    if (!subtitleContent) {
                        subtitleContent = await downloadSubtitleWithYtdlCore(videoId, language);
                    }

                    // If both fail, try node-subtitles
                    if (!subtitleContent) {
                        subtitleContent = await downloadSubtitleWithNodeSubtitles(videoId, language);
                    }

                    if (!subtitleContent) {
                        throw new Error('Không thể tải phụ đề từ bất kỳ nguồn nào');
                    }

                    const convertedContent = convertSubtitleFormat(subtitleContent, format);
                    if (!convertedContent) {
                        throw new Error('Không thể chuyển đổi định dạng phụ đề');
                    }

                    await fsPromises.writeFile(filePath, convertedContent);
                    downloadProgressMap.set(downloadId, { 
                        progress: 100, 
                        downloadUrl: `/subtitles/${encodeURIComponent(fileName)}`, 
                        error: null 
                    });
                } catch (error) {
                    logger.error(`Subtitle download error: ${error.message}`);
                    downloadProgressMap.set(downloadId, { progress: 0, error: error.message });
                }
            })();
        } else {
            throw new Error('Nền tảng không được hỗ trợ');
        }
    } catch (error) {
        logger.error(`Subtitle Download Error: ${error.message}`);
        return res.status(500).json({ error: error.message || 'Lỗi server khi tải phụ đề.' });
    }
}

// Hàm tải tất cả phụ đề
async function downloadAllSubtitles(url, downloadProgressMap) {
    const downloadId = uuidv4();
    downloadProgressMap.set(downloadId, { progress: 0, error: null });

    try {
        const videoId = url.match(/[?&]v=([^&]+)/)?.[1] || url.match(/youtu\.be\/([^?&]+)/)?.[1];
        if (!videoId) {
            throw new Error('URL YouTube không hợp lệ');
        }

        // Kiểm tra tính khả dụng của video
        const availability = await checkVideoAvailability(videoId);
        if (!availability.isAvailable) {
            throw new Error(availability.reason);
        }

        // Lấy danh sách ngôn ngữ phụ đề khả dụng
        const { manual: manualLanguages, auto: autoLanguages } = await getAvailableSubtitleLanguages(url);
        const allLanguages = [...new Set([...manualLanguages, ...autoLanguages])];
        
        if (allLanguages.length === 0) {
            throw new Error('Video không có phụ đề nào khả dụng.');
        }

        // Tạo thư mục tạm và thư mục phụ đề
        const tempDir = path.join(__dirname, 'temp');
        const subtitlesDir = path.join(__dirname, 'subtitles');
        await fsPromises.mkdir(tempDir, { recursive: true });
        await fsPromises.mkdir(subtitlesDir, { recursive: true });
        await cleanFolder(subtitlesDir);

        // Lấy tiêu đề video
        const videoTitle = await getVideoTitle(videoId) || `Video_YouTube_${videoId}`;
        downloadProgressMap.set(downloadId, { progress: 20, error: null });

        const subtitleFiles = [];
        const formats = ['srt', 'vtt', 'txt'];
        let successCount = 0;

        // Tải phụ đề cho mỗi ngôn ngữ
        for (const lang of allLanguages) {
            try {
                let subtitleContent = null;
                let selectedLang = lang;

                // Phương pháp 1: Sử dụng @distube/ytdl-core
                subtitleContent = await downloadSubtitleWithYtdlCore(videoId, lang);

                // Phương pháp 2: Thử với yt-dlp nếu phương pháp 1 thất bại
                if (!subtitleContent) {
                    const outputPath = path.join(tempDir, `${videoTitle}.${lang}.vtt`);
                    subtitleContent = await downloadSubtitleWithYtDlp(url, lang, outputPath);
                }

                // Phương pháp 3: Thử với node-youtube-subtitles
                if (!subtitleContent) {
                    subtitleContent = await downloadSubtitleWithNodeSubtitles(videoId, lang);
                }

                // Phương pháp 4: Thử với YouTube API
                if (!subtitleContent) {
                    subtitleContent = await downloadSubtitleWithYouTubeAPI(videoId, lang);
                }

                if (subtitleContent && subtitleContent.trim() !== '') {
                    // Chuyển đổi sang các định dạng khác nhau
                    for (const format of formats) {
                        let content = subtitleContent;
                        if (format === 'txt') {
                            content = extractTextFromVtt(content);
                        } else if (format === 'srt') {
                            content = convertVttToSrt(content);
                        }

                        if (content && content.trim() !== '') {
                            const fileName = `${sanitizeFileName(videoTitle)}_${selectedLang}.${format}`;
                            const filePath = path.join(subtitlesDir, fileName);
                            await fsPromises.writeFile(filePath, content, 'utf8');
                            subtitleFiles.push({
                                language: selectedLang,
                                format,
                                downloadUrl: `/subtitles/${encodeURIComponent(fileName)}`
                            });
                            successCount++;
                        }
                    }
                }
            } catch (langError) {
                logger.error(`Error downloading subtitles for ${lang}: ${langError.message}`);
            }
        }

        // Cập nhật tiến trình
        const progress = Math.min(20 + Math.floor((successCount / (allLanguages.length * formats.length)) * 80), 100);
        downloadProgressMap.set(downloadId, {
            progress,
            subtitles: subtitleFiles,
            error: null
        });

        // Xóa thư mục tạm
        try {
            await fsPromises.rm(tempDir, { recursive: true, force: true });
        } catch (cleanupError) {
            logger.error(`Error cleaning up temp directory: ${cleanupError.message}`);
        }

        return subtitleFiles;
    } catch (error) {
        logger.error(`Download All Subtitles Error: ${error.message}`);
        downloadProgressMap.set(downloadId, { progress: 0, error: error.message });
        throw error;
    }
}

async function downloadSubtitleWithRetry(url, language, isAuto = false, retries = 3) {
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            // Phương pháp 1: Sử dụng @distube/ytdl-core
            const info = await ytdl.getInfo(url, { 
                timeout: 30000,
                requestOptions: {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                    }
                }
            });
            const captions = info.player_response.captions;
            if (!captions || !captions.playerCaptionsTracklistRenderer) {
                throw new Error('Video không có phụ đề nào');
            }

            const captionTracks = captions.playerCaptionsTracklistRenderer.captionTracks || [];
            const translationLanguages = captions.playerCaptionsTracklistRenderer.translationLanguages || [];
            
            let subtitleContent = null;
            if (!isAuto) {
                const caption = captionTracks.find(track => track.languageCode === language);
                if (caption) {
                    const response = await fetchWithRetry(caption.baseUrl, { 
                        responseType: 'text',
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                        }
                    }, 3, 2000);
                    subtitleContent = response.data;
                }
            } else {
                const autoLang = translationLanguages.find(tLang => tLang.languageCode === language);
                if (autoLang && captionTracks[0]) {
                    const autoCaptionUrl = `${captionTracks[0]?.baseUrl}&tlang=${language}`;
                    const response = await fetchWithRetry(autoCaptionUrl, { 
                        responseType: 'text',
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                        }
                    }, 3, 2000);
                    subtitleContent = response.data;
                }
            }

            if (subtitleContent && subtitleContent.trim()) {
                return subtitleContent;
            }

            // Phương pháp 2: Sử dụng yt-dlp
            const tempDir = path.join(__dirname, 'temp');
            if (!await fsPromises.access(tempDir).then(() => true).catch(() => false)) {
                await fsPromises.mkdir(tempDir, { recursive: true });
            }

            const outputPath = path.join(tempDir, `subtitle_${language}.vtt`);
            await ytDlp(url, {
                skipDownload: true,
                writeSub: !isAuto,
                writeAutoSub: isAuto,
                subLang: language,
                subFormat: 'vtt',
                output: outputPath,
                timeout: 30000
            });

            if (await fsPromises.access(outputPath).then(() => true).catch(() => false)) {
                subtitleContent = await fsPromises.readFile(outputPath, 'utf8');
                await fsPromises.unlink(outputPath);
                if (subtitleContent && subtitleContent.trim()) {
                    return subtitleContent;
                }
            }

            // Phương pháp 3: Sử dụng youtube-caption-extractor
            const videoId = url.match(/[?&]v=([^&]+)/)?.[1] || url.match(/youtu\.be\/([^?&]+)/)?.[1];
            if (videoId) {
                let subtitles = await getYTSubtitles({ 
                    videoId, 
                    lang: language,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                    }
                });
                if (!subtitles || subtitles.length === 0) {
                    subtitles = await getYTSubtitles({ 
                        videoId, 
                        lang: language, 
                        tlang: language,
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                        }
                    });
                }
                if (subtitles && subtitles.length > 0) {
                    subtitleContent = arrayToVtt(subtitles);
                    if (subtitleContent && subtitleContent.trim()) {
                        return subtitleContent;
                    }
                }
            }

            throw new Error('Không thể tải phụ đề từ bất kỳ phương pháp nào');
        } catch (error) {
            logger.error(`Attempt ${attempt + 1}/${retries} failed: ${error.message}`);
            if (attempt === retries - 1) {
                throw error;
            }
            // Tăng thời gian chờ giữa các lần thử
            await new Promise(resolve => setTimeout(resolve, Math.min(1000 * Math.pow(2, attempt), 10000)));
        }
    }
}

// Hàm chuyển đổi phụ đề XML sang VTT
function convertXmlToVtt(xmlContent) {
    try {
        if (!xmlContent || xmlContent.trim() === '') {
            logger.error('Empty XML content for conversion');
            return null;
        }

        // Parse XML content using jsdom
        const dom = new JSDOM(xmlContent, { contentType: 'text/xml' });
        const xmlDoc = dom.window.document;
        const textElements = xmlDoc.getElementsByTagName('text');

        if (!textElements || textElements.length === 0) {
            logger.error('No text elements found in XML');
            return null;
        }

        // Convert to VTT format
        let vttContent = 'WEBVTT\n\n';
        for (let i = 0; i < textElements.length; i++) {
            const text = textElements[i];
            const start = text.getAttribute('start');
            const dur = text.getAttribute('dur');
            
            if (!start || !dur) {
                continue;
            }

            const startTime = msToTime(parseFloat(start) * 1000);
            const endTime = msToTime((parseFloat(start) + parseFloat(dur)) * 1000);
            const content = text.textContent.trim();

            if (content) {
                vttContent += `${startTime} --> ${endTime}\n${content}\n\n`;
            }
        }

        return vttContent.trim() === 'WEBVTT' ? null : vttContent.trim();
    } catch (error) {
        logger.error(`Error converting XML to VTT: ${error.message}`);
        return null;
    }
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

// Hàm bổ sung số 0 cho định dạng thời gian
function pad(num, size = 2) {
    return num.toString().padStart(size, '0');
}

module.exports = {
    handleDownloadSubtitle,
    downloadAllSubtitles,
    convertXmlToVtt,
    msToTime,
    pad
};