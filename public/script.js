document.addEventListener('DOMContentLoaded', () => {
    const videoUrlInput = document.getElementById('videoUrl');
    const fetchBtn = document.getElementById('fetchBtn');
    const downloadVideoBtn = document.getElementById('downloadVideoBtn');
    const downloadAudioBtn = document.getElementById('downloadAudioBtn');
    const copyTitleBtn = document.getElementById('copyTitleBtn');
    const resultDiv = document.getElementById('result');
    const platformIcon = document.getElementById('platformIcon');
    const contentPreview = document.getElementById('contentPreview');
    const thumbnail = document.getElementById('thumbnail');
    const title = document.getElementById('title');
    const downloadThumbnailBtn = document.getElementById('downloadThumbnailBtn');
    const thumbnailResolutions = document.getElementById('thumbnailResolutions');
    const thumbnailList = document.querySelector('.thumbnail-list');
    const downloadSubtitleBtn = document.getElementById('downloadSubtitleBtn');
    const subtitleLanguage = document.getElementById('subtitleLanguage');
    const subtitleFormat = document.getElementById('subtitleFormat');
    const pasteBtn = document.getElementById('pasteBtn');
    const clearBtn = document.getElementById('clearBtn');
    const validationIcon = document.getElementById('validationIcon');

    let selectedThumbnail = null;
    let currentVideoId = null;
    let isInfoHidden = false;

    // Hàm chuẩn hóa tên file
    function sanitizeFileName(filename) {
        return filename
            .replace(/[<>:"\/\\|?*\x00-\x1F]/g, '_') // Loại bỏ ký tự không hợp lệ
            .replace(/\s+/g, '_') // Thay khoảng trắng bằng dấu gạch dưới
            .replace(/\.+/g, '.') // Loại bỏ nhiều dấu chấm liên tiếp
            .replace(/^\.+|\.+$/g, '') // Loại bỏ dấu chấm ở đầu và cuối
            .substring(0, 50) // Giới hạn độ dài tên file
            .trim();
    }

    function normalizeUrl(url) {
        if (!url) return '';
        url = url.trim();
        if (!url.match(/^https?:\/\//)) {
            url = 'https://' + url;
        }
        return url;
    }

    function isValidUrl(url) {
        try {
            new URL(url);
            return true;
        } catch {
            return false;
        }
    }

    function detectPlatform(url) {
        if (!url || !isValidUrl(url)) return null;
        url = url.toLowerCase();
        const patterns = {
            tiktok: [/tiktok\.com/i, /tiktok\.com\/t\//i, /vt\.tiktok\.com/i],
            instagram: [/instagram\.com/i, /instagr\.am/i],
            youtube: [/youtube\.com/i, /youtu\.be/i, /youtube-nocookie\.com/i],
            twitter: [/twitter\.com/i, /x\.com/i],
            facebook: [/facebook\.com/i, /fb\.com/i, /fb\.watch/i],
            douyin: [/douyin\.com/i]
        };
        for (const [platform, regexes] of Object.entries(patterns)) {
            if (regexes.some(regex => regex.test(url))) {
                return platform;
            }
        }
        return null;
    }

    function updatePlatformIcon(platform) {
        platformIcon.classList.remove('active', 'fa-tiktok', 'fa-instagram', 'fa-youtube', 'fa-twitter', 'fa-facebook', 'fa-douyin');
        if (platform) {
            const iconClass = platform === 'douyin' ? 'fa-douyin' : `fa-${platform}`;
            platformIcon.classList.add('active', iconClass);
        }
    }

    async function fetchMetadata(url, platform) {
        try {
            const response = await fetch('/api/metadata', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url, platform })
            });
            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.error || 'Không thể lấy dữ liệu');
            }
            if (!data.title) {
                data.title = platform === 'youtube' ? 'Video YouTube mẫu' : 'Mẫu tiêu đề video';
            }
            return data;
        } catch (error) {
            console.error('Metadata Error:', error);
            throw error;
        }
    }

    // Thêm hàm getYouTubeVideoId vào phần UTILITY FUNCTIONS
    const utils = {
        // ... các hàm utility khác ...

        /**
         * Lấy ID video từ URL YouTube
         * @param {string} url - URL YouTube
         * @returns {string|null} ID video hoặc null nếu không tìm thấy
         */
        getYouTubeVideoId(url) {
            if (!url) return null;
            
            const patterns = [
                /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
                /youtube\.com\/shorts\/([^&\n?#]+)/,
                /youtube\.com\/v\/([^&\n?#]+)/
            ];

            for (const pattern of patterns) {
                const match = url.match(pattern);
                if (match && match[1]) {
                    return match[1];
                }
            }

            return null;
        }
    };

    function displayThumbnailResolutions(videoId) {
        const resolutions = [
            { name: 'HD (1280x720)', url: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg` },
            { name: 'SD (640x480)', url: `https://img.youtube.com/vi/${videoId}/sddefault.jpg` },
            { name: 'Medium (480x360)', url: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg` },
            { name: 'Small (320x180)', url: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg` },
            { name: 'Tiny (120x90)', url: `https://img.youtube.com/vi/${videoId}/default.jpg` }
        ];

        thumbnailList.innerHTML = '';
        resolutions.forEach(res => {
            const item = document.createElement('div');
            item.className = 'thumbnail-item';
            const img = document.createElement('img');
            img.src = res.url;
            img.alt = res.name;
            img.onerror = () => { img.src = 'https://via.placeholder.com/120x90?text=Not+Available'; };
            const label = document.createElement('span');
            label.textContent = res.name;

            item.addEventListener('click', () => {
                thumbnailList.querySelectorAll('.thumbnail-item').forEach(el => el.classList.remove('selected'));
                item.classList.add('selected');
                selectedThumbnail = { url: res.url, name: res.name };
            });

            item.appendChild(img);
            item.appendChild(label);
            thumbnailList.appendChild(item);
        });

        thumbnailResolutions.style.display = 'block';
        if (resolutions.length > 0) {
            thumbnailList.firstChild.classList.add('selected');
            selectedThumbnail = { url: resolutions[0].url, name: resolutions[0].name };
        }
    }

    function downloadThumbnail(url, name) {
        const spinner = downloadThumbnailBtn.querySelector('.spinner');
        spinner.style.display = 'inline';
        downloadThumbnailBtn.disabled = true;

        try {
            if (!url || url.includes('via.placeholder.com')) {
                throw new Error('Không có thumbnail để tải');
            }

            fetch(url)
                .then(response => response.blob())
                .then(blob => {
                    const blobUrl = window.URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = blobUrl;
                    const sanitizedTitle = sanitizeFileName(title.textContent || 'thumbnail');
                    const sanitizedName = sanitizeFileName(name.replace(/\s*\([^)]+\)/g, ''));
                    a.download = `${sanitizedTitle}_${sanitizedName}.jpg`;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    window.URL.revokeObjectURL(blobUrl);

                    Swal.fire({
                        title: 'Thành công',
                        text: 'Đã tải thumbnail thành công!',
                        icon: 'success',
                        timer: 2000,
                        showConfirmButton: false,
                        customClass: {
                            popup: 'swal-popup',
                            title: 'swal-title',
                            content: 'swal-content'
                        }
                    });
                })
                .catch(error => {
                    throw new Error('Không thể tải hình ảnh: ' + error.message);
                });
        } catch (error) {
            Swal.fire({
                title: 'Lỗi',
                text: error.message || 'Không thể tải thumbnail. Vui lòng thử lại!',
                icon: 'error',
                confirmButtonText: 'OK',
                customClass: {
                    popup: 'swal-popup',
                    title: 'swal-title',
                    content: 'swal-content',
                    confirmButton: 'swal-button'
                }
            });
        } finally {
            spinner.style.display = 'none';
            downloadThumbnailBtn.disabled = false;
        }
    }

    async function downloadContent(type, btn, apiEndpoint, successMessage, downloadLabel) {
        const rawUrl = videoUrlInput.value;
        const url = normalizeUrl(rawUrl);
        const platform = detectPlatform(url);
        const quality = document.querySelector('input[name="quality"]:checked')?.value || 'high';
        const language = type === 'subtitle' ? subtitleLanguage.value : null;
        const format = type === 'subtitle' ? subtitleFormat.value : null;

        if (!platform) {
            Swal.fire({
                title: 'Lỗi',
                text: 'Vui lòng nhập link hợp lệ và nhấn Tải Ngay!',
                icon: 'error',
                confirmButtonText: 'OK',
                customClass: {
                    popup: 'swal-popup',
                    title: 'swal-title',
                    content: 'swal-content',
                    confirmButton: 'swal-button'
                }
            });
            return;
        }

        if (type === 'subtitle' && (!language || !format)) {
            Swal.fire({
                title: 'Lỗi',
                text: 'Vui lòng chọn ngôn ngữ và định dạng phụ đề!',
                icon: 'error',
                confirmButtonText: 'OK',
                customClass: {
                    popup: 'swal-popup',
                    title: 'swal-title',
                    content: 'swal-content',
                    confirmButton: 'swal-button'
                }
            });
            return;
        }

        const spinner = btn.querySelector('.spinner');
        spinner.style.display = 'inline';
        btn.disabled = true;

        let eventSource = null;
        let downloadId = null;

        let progressPopup = Swal.fire({
            title: `Đang tải ${type === 'video' ? 'video' : type === 'audio' ? 'âm thanh' : 'phụ đề'}...`,
            html: `
                <div class="progress-wrapper">
                    <div class="progress-container">
                        <div class="progress-bar-3d">
                            <div class="progress-fill-3d" id="progressBar3D"></div>
                        </div>
                        <div class="progress-text" id="progressText">0%</div>
                        <div class="progress-status" id="progressStatus">Đang chuẩn bị tải...</div>
                    </div>
                </div>
            `,
            allowOutsideClick: false,
            allowEscapeKey: true,
            showConfirmButton: false,
            showCloseButton: true,
            customClass: {
                popup: 'swal-popup',
                title: 'swal-title',
                content: 'swal-content',
                closeButton: 'swal-close-button'
            },
            willClose: () => {
                if (eventSource) {
                    eventSource.close();
                    // Gửi yêu cầu hủy tải xuống
                    if (downloadId) {
                        fetch(`/api/cancel-download/${downloadId}`, { method: 'POST' });
                    }
                }
            }
        });

        // Thêm CSS cho thanh tiến trình 3D và nút đóng
        const style = document.createElement('style');
        style.textContent = `
            .progress-wrapper {
                padding: 20px;
                text-align: center;
            }
            .progress-container {
                position: relative;
                margin: 20px auto;
                width: 80%;
            }
            .progress-bar-3d {
                position: relative;
                height: 30px;
                background: #f0f0f0;
                border-radius: 15px;
                box-shadow: inset 0 2px 4px rgba(0,0,0,0.1);
                overflow: hidden;
            }
            .progress-fill-3d {
                position: absolute;
                top: 0;
                left: 0;
                height: 100%;
                background: linear-gradient(45deg, #2196F3, #4CAF50);
                border-radius: 15px;
                transition: width 0.3s ease;
                box-shadow: 0 2px 4px rgba(0,0,0,0.2);
                width: 0%;
            }
            .progress-text {
                position: absolute;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                color: #333;
                font-weight: bold;
                text-shadow: 1px 1px 1px rgba(255,255,255,0.5);
                z-index: 1;
            }
            .progress-status {
                margin-top: 10px;
                color: #666;
                font-size: 14px;
            }
            .swal-close-button {
                position: absolute;
                top: 10px;
                right: 10px;
                width: 30px;
                height: 30px;
                border-radius: 50%;
                background: #ffffff;
                color: #333;
                border: 2px solid #e0e0e0;
                font-size: 20px;
                line-height: 30px;
                cursor: pointer;
                transition: all 0.3s ease;
                box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            }
            .swal-close-button:hover {
                background: #f5f5f5;
                transform: scale(1.1);
                border-color: #bdbdbd;
            }
            .swal-popup {
                border-radius: 15px;
                box-shadow: 0 5px 15px rgba(0,0,0,0.2);
            }
            .swal-title {
                color: #333;
                font-size: 24px;
                margin-bottom: 20px;
            }
            .swal-content {
                padding: 20px;
            }
        `;
        document.head.appendChild(style);

        try {
            const response = await fetch(apiEndpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    url, 
                    platform, 
                    type, 
                    quality, 
                    targetLanguage: language, 
                    formatPreference: format
                })
            });
            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Có lỗi xảy ra khi tải nội dung');
            }

            if (data.message === 'Đang tải, vui lòng chờ...') {
                downloadId = data.downloadId;
                eventSource = new EventSource(`/api/download-progress/${downloadId}`);
                let lastProgress = 0;
                let downloadAttempts = 0;
                const maxAttempts = 3;
                let downloadUrl = null;

                eventSource.onmessage = (event) => {
                    const progressData = JSON.parse(event.data);
                    const progress = Math.min(progressData.progress, 100);
                    const status = progressData.status || 'Đang tải...';
                    
                    const progressFill = document.getElementById('progressBar3D');
                    const progressText = document.getElementById('progressText');
                    const progressStatus = document.getElementById('progressStatus');
                    
                    // Cập nhật trạng thái chi tiết hơn
                    if (progressData.stage) {
                        progressStatus.textContent = `Đang ${progressData.stage}...`;
                    } else {
                        progressStatus.textContent = status;
                    }

                    // Cập nhật tiến trình mượt mà
                    if (progress > lastProgress) {
                        const updateProgress = () => {
                            if (lastProgress < progress) {
                                lastProgress = Math.min(lastProgress + 1, progress);
                                progressFill.style.width = `${lastProgress}%`;
                                progressText.textContent = `${lastProgress}%`;
                                
                                if (lastProgress < progress) {
                                    setTimeout(updateProgress, 20);
                                }
                            }
                        };
                        updateProgress();
                    } else if (progress === 0 && progressData.stage) {
                        // Hiển thị trạng thái khi đang xử lý nhưng chưa có tiến trình
                        progressFill.style.width = '5%';
                        progressText.textContent = 'Đang xử lý...';
                    }

                    if (progress === 100) {
                        downloadUrl = progressData.downloadUrl;
                        eventSource.close();
                        Swal.close();
                        showDownloadCompletePopup(type, downloadUrl, downloadLabel, language, format);
                    }

                    if (progressData.error) {
                        eventSource.close();
                        Swal.close();
                        Swal.fire({
                            title: 'Lỗi tải xuống',
                            text: progressData.error,
                            icon: 'error',
                            confirmButtonText: 'OK',
                            customClass: {
                                popup: 'swal-popup',
                                title: 'swal-title',
                                content: 'swal-content',
                                confirmButton: 'swal-button'
                            }
                        });
                    }
                };

                eventSource.onerror = () => {
                    eventSource.close();
                    Swal.close();
                    Swal.fire({
                        title: 'Lỗi tải xuống',
                        text: 'Không thể theo dõi tiến trình tải. Vui lòng thử lại!',
                        icon: 'error',
                        confirmButtonText: 'OK',
                        customClass: {
                            popup: 'swal-popup',
                            title: 'swal-title',
                            content: 'swal-content',
                            confirmButton: 'swal-button'
                        }
                    });
                };
            } else if (data.downloadUrl) {
                // Xử lý tải xuống trực tiếp
                handleDirectDownload(data.downloadUrl, type, language, format, downloadLabel);
            } else {
                throw new Error('Không tìm thấy nội dung để tải.');
            }
        } catch (error) {
            handleDownloadError(error.message);
        } finally {
            spinner.style.display = 'none';
            btn.disabled = false;
        }
    }

    // Cập nhật hàm showDownloadCompletePopup với xử lý lỗi chi tiết
    function showDownloadCompletePopup(type, downloadUrl, downloadLabel, language, format) {
        Swal.fire({
            title: `Tải ${type === 'video' ? 'video' : type === 'audio' ? 'âm thanh' : 'phụ đề'} hoàn tất!`,
            html: `
                <p>Nhấn nút bên dưới để tải ${type === 'video' ? 'video' : type === 'audio' ? 'âm thanh' : 'phụ đề'}.</p>
                <div class="custom-download-btn-container">
                    <button id="downloadConfirmBtn" class="custom-download-btn">
                        <i class="fas fa-download"></i> Download ${downloadLabel}
                    </button>
                </div>
            `,
            showConfirmButton: false,
            didOpen: () => {
                const downloadBtn = document.getElementById('downloadConfirmBtn');
                downloadBtn.addEventListener('click', async () => {
                    try {
                        // Tạo thẻ a để tải xuống
                        const link = document.createElement('a');
                        link.href = downloadUrl;
                        
                        // Đặt tên file
                        const sanitizedTitle = sanitizeFileName(title.textContent || 'content');
                        const extension = type === 'video' ? 'mp4' : type === 'audio' ? 'mp3' : `${language}.${format}`;
                        link.download = `${sanitizedTitle}.${extension}`;
                        
                        // Thêm link vào DOM và click
                        document.body.appendChild(link);
                        link.click();
                        document.body.removeChild(link);

                        // Đóng popup
                        Swal.close();
                        
                        // Hiển thị thông báo thành công
                        Swal.fire({
                            title: 'Thành công',
                            text: 'Đã bắt đầu tải xuống!',
                            icon: 'success',
                            timer: 2000,
                            showConfirmButton: false
                        });

                    } catch (error) {
                        console.error('Download error:', error);
                        Swal.fire({
                            title: 'Lỗi tải xuống',
                            text: error.message || 'Đã xảy ra lỗi khi tải file',
                            icon: 'error',
                            confirmButtonText: 'Thử lại',
                            showCancelButton: true,
                            cancelButtonText: 'Đóng'
                        });
                    }
                });
            },
            customClass: {
                popup: 'swal-popup',
                title: 'swal-title',
                content: 'swal-content'
            }
        });
    }

    // Thêm hàm format kích thước file
    function formatFileSize(bytes) {
        if (!bytes) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    // Hàm lưu thông tin tải xuống
    function saveDownloadInfo(downloadInfo) {
        try {
            const downloads = JSON.parse(localStorage.getItem('downloads') || '[]');
            downloads.push(downloadInfo);
            // Giới hạn lưu 10 lần tải xuống gần nhất
            if (downloads.length > 10) {
                downloads.shift();
            }
            localStorage.setItem('downloads', JSON.stringify(downloads));
        } catch (error) {
            console.error('Lỗi khi lưu thông tin tải xuống:', error);
        }
    }

    // Hàm xử lý lỗi tải xuống
    function handleDownloadError(errorMessage) {
        if (eventSource) {
            eventSource.close();
        }
        Swal.close();
        resultDiv.classList.remove('loading');
        resultDiv.innerHTML = '';
        Swal.fire({
            title: 'Lỗi tải xuống',
            text: errorMessage || 'Có lỗi xảy ra khi tải nội dung. Vui lòng thử lại!',
            icon: 'error',
            confirmButtonText: 'OK',
            customClass: {
                popup: 'swal-popup',
                title: 'swal-title',
                content: 'swal-content',
                confirmButton: 'swal-button'
            }
        });
    }

    // Hàm xử lý tải xuống trực tiếp
    function handleDirectDownload(downloadUrl, type, language, format, downloadLabel) {
        const progressBar = document.getElementById('progressBar3D');
        const progressText = document.getElementById('progressText');
        
        let progress = 0;
        const updateProgress = () => {
            if (progress < 100) {
                progress++;
                progressBar.style.width = `${progress}%`;
                progressText.textContent = `${progress}%`;
                setTimeout(updateProgress, 20);
            } else {
                Swal.close();
                showDownloadCompletePopup(type, downloadUrl, downloadLabel, language, format);
            }
        };
        updateProgress();
    }

    // Hàm xử lý nút dán
    pasteBtn.addEventListener('click', async () => {
        try {
            const text = await navigator.clipboard.readText();
            videoUrlInput.value = text;
            videoUrlInput.dispatchEvent(new Event('input'));
        } catch (err) {
            Swal.fire({
                title: 'Lỗi',
                text: 'Không thể dán từ clipboard. Vui lòng thử lại!',
                icon: 'error',
                confirmButtonText: 'OK',
                customClass: {
                    popup: 'swal-popup',
                    title: 'swal-title',
                    content: 'swal-content',
                    confirmButton: 'swal-button'
                }
            });
        }
    });

    // Hàm xử lý nút xóa
    clearBtn.addEventListener('click', () => {
        videoUrlInput.value = '';
        videoUrlInput.dispatchEvent(new Event('input'));
        pasteBtn.style.display = 'flex';
        clearBtn.style.display = 'none';
        validationIcon.classList.remove('visible');
        if (isInfoHidden) {
            toggleInfoSections();
        }
    });

    // Cập nhật hiển thị nút dán/xóa và icon validation
    videoUrlInput.addEventListener('input', async () => {
        const rawUrl = videoUrlInput.value;
        const url = normalizeUrl(rawUrl);

        if (!rawUrl) {
            updatePlatformIcon(null);
            contentPreview.style.display = 'none';
            currentVideoId = null;
            pasteBtn.style.display = 'flex';
            clearBtn.style.display = 'none';
            validationIcon.classList.remove('visible');
            return;
        }

        if (!isValidUrl(url)) {
            updatePlatformIcon(null);
            contentPreview.style.display = 'none';
            pasteBtn.style.display = 'none';
            clearBtn.style.display = 'flex';
            validationIcon.classList.remove('visible');
            Swal.fire({
                title: 'Link không hợp lệ',
                text: 'Vui lòng nhập một URL hợp lệ (ví dụ: https://youtu.be/...)',
                icon: 'error',
                confirmButtonText: 'OK',
                customClass: {
                    popup: 'swal-popup',
                    title: 'swal-title',
                    content: 'swal-content',
                    confirmButton: 'swal-button'
                }
            });
            return;
        }

        const platform = detectPlatform(url);
        if (platform) {
            updatePlatformIcon(platform);
            pasteBtn.style.display = 'none';
            clearBtn.style.display = 'flex';
            validationIcon.classList.add('visible');
            try {
                const metadata = await fetchMetadata(url, platform);
                currentVideoId = metadata.videoId;
            } catch (error) {
                Swal.fire({
                    title: 'Lỗi',
                    text: error.message || 'Không thể lấy dữ liệu. Vui lòng thử lại!',
                    icon: 'error',
                    confirmButtonText: 'OK',
                    customClass: {
                        popup: 'swal-popup',
                        title: 'swal-title',
                        content: 'swal-content',
                        confirmButton: 'swal-button'
                    }
                });
            }
        } else {
            updatePlatformIcon(null);
            contentPreview.style.display = 'none';
            pasteBtn.style.display = 'none';
            clearBtn.style.display = 'flex';
            validationIcon.classList.remove('visible');
            Swal.fire({
                title: 'Nền tảng không được hỗ trợ',
                text: 'Vui lòng dán link từ YouTube.',
                icon: 'warning',
                confirmButtonText: 'OK',
                customClass: {
                    popup: 'swal-popup',
                    title: 'swal-title',
                    content: 'swal-content',
                    confirmButton: 'swal-button'
                }
            });
        }
    });

    copyTitleBtn.addEventListener('click', () => {
        const text = title.textContent;
        navigator.clipboard.writeText(text).then(() => {
            Swal.fire({
                title: 'Đã sao chép',
                text: 'Tiêu đề đã được sao chép!',
                icon: 'success',
                timer: 1500,
                showConfirmButton: false,
                customClass: {
                    popup: 'swal-popup',
                    title: 'swal-title',
                    content: 'swal-content'
                }
            });
        }).catch(err => {
            Swal.fire({
                title: 'Lỗi',
                text: 'Không thể sao chép tiêu đề!',
                icon: 'error',
                confirmButtonText: 'OK',
                customClass: {
                    popup: 'swal-popup',
                    title: 'swal-title',
                    content: 'swal-content',
                    confirmButton: 'swal-button'
                }
            });
        });
    });

    // Hàm ẩn/hiện thông tin cập nhật và hướng dẫn
    function toggleInfoSections() {
        const updateInfo = document.querySelector('.update-info');
        const usageGuide = document.querySelector('.usage-guide');
        
        if (!isInfoHidden) {
            updateInfo.classList.add('hidden');
            usageGuide.classList.add('hidden');
            isInfoHidden = true;
        } else {
            updateInfo.classList.remove('hidden');
            usageGuide.classList.remove('hidden');
            isInfoHidden = false;
        }
    }

    fetchBtn.addEventListener('click', async () => {
        const url = videoUrlInput.value.trim();
        if (!url) {
            Swal.fire({
                icon: 'error',
                title: 'Lỗi!',
                text: 'Vui lòng nhập URL video!'
            });
            return;
        }

        if (!isValidUrl(url)) {
            Swal.fire({
                icon: 'error',
                title: 'Lỗi!',
                text: 'URL không hợp lệ!'
            });
            return;
        }

        // Ẩn thông tin cập nhật và hướng dẫn khi bắt đầu tải
        toggleInfoSections();

        const platform = detectPlatform(url);
        if (!platform) {
            Swal.fire({
                title: 'Nền tảng không được hỗ trợ',
                text: 'Vui lòng dán link từ YouTube.',
                icon: 'warning',
                confirmButtonText: 'OK',
                customClass: {
                    popup: 'swal-popup',
                    title: 'swal-title',
                    content: 'swal-content',
                    confirmButton: 'swal-button'
                }
            });
            return;
        }

        resultDiv.classList.add('loading');
        resultDiv.innerHTML = 'Đang lấy dữ liệu...';

        try {
            const metadata = await fetchMetadata(url, platform);
            currentVideoId = metadata.videoId;
            thumbnail.src = metadata.thumbnail || 'https://via.placeholder.com/300x150?text=Thumbnail+Not+Available';
            title.textContent = metadata.title || (platform === 'youtube' ? 'Video YouTube mẫu' : 'Mẫu tiêu đề video');

            contentPreview.style.display = 'flex';
            contentPreview.classList.add('active');
            resultDiv.classList.remove('loading');
            resultDiv.innerHTML = '';

            if (platform === 'youtube') {
                const videoId = utils.getYouTubeVideoId(url);
                if (videoId) {
                    displayThumbnailResolutions(videoId);
                } else {
                    thumbnailResolutions.style.display = 'none';
                }
            } else {
                thumbnailResolutions.style.display = 'none';
            }
        } catch (error) {
            resultDiv.classList.remove('loading');
            Swal.fire({
                title: 'Lỗi',
                text: error.message || 'Không thể lấy dữ liệu. Vui lòng thử lại!',
                icon: 'error',
                confirmButtonText: 'OK',
                customClass: {
                    popup: 'swal-popup',
                    title: 'swal-title',
                    content: 'swal-content',
                    confirmButton: 'swal-button'
                }
            });
        }

        updatePlatformIcon(platform);
    });

    downloadVideoBtn.addEventListener('click', () => downloadContent('video', downloadVideoBtn, '/api/download', 'Đã tải video thành công!', 'Video'));
    downloadAudioBtn.addEventListener('click', () => downloadContent('audio', downloadAudioBtn, '/api/download', 'Đã tải âm thanh thành công!', 'Âm Thanh'));
    downloadSubtitleBtn.addEventListener('click', () => downloadContent('subtitle', downloadSubtitleBtn, '/api/download-subtitle', 'Đã tải phụ đề thành công!', 'Phụ Đề'));

    downloadThumbnailBtn.addEventListener('click', () => {
        const spinner = downloadThumbnailBtn.querySelector('.spinner');
        spinner.style.display = 'inline';
        downloadThumbnailBtn.disabled = true;

        try {
            if (!selectedThumbnail || !selectedThumbnail.url || selectedThumbnail.url.includes('via.placeholder.com')) {
                throw new Error('Vui lòng chọn một thumbnail hợp lệ');
            }

            downloadThumbnail(selectedThumbnail.url, selectedThumbnail.name);
        } catch (error) {
            Swal.fire({
                title: 'Lỗi',
                text: error.message || 'Không thể tải thumbnail. Vui lòng thử lại!',
                icon: 'error',
                confirmButtonText: 'OK',
                customClass: {
                    popup: 'swal-popup',
                    title: 'swal-title',
                    content: 'swal-content',
                    confirmButton: 'swal-button'
                }
            });
            spinner.style.display = 'none';
            downloadThumbnailBtn.disabled = false;
        }
    });
});