async function downloadVideo() {
    try {
        const url = document.getElementById('url').value;
        const platform = document.getElementById('platform').value;
        const quality = document.getElementById('quality').value;
        const type = document.getElementById('type').value;

        if (!url) {
            showError('Vui lòng nhập URL');
            return;
        }

        if (!isValidUrl(url)) {
            showError('URL không hợp lệ');
            return;
        }

        showLoading();
        const response = await fetch('/api/download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, platform, quality, type })
        });

        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Lỗi tải video');
        }

        const data = await response.json();
        if (data.error) {
            throw new Error(data.error);
        }

        if (data.downloadUrl) {
            window.location.href = data.downloadUrl;
        }
    } catch (error) {
        showError(error.message);
    } finally {
        hideLoading();
    }
}

async function downloadSubtitle() {
    try {
        const url = document.getElementById('url').value;
        const platform = document.getElementById('platform').value;
        const targetLanguage = document.getElementById('targetLanguage').value;
        const formatPreference = document.getElementById('formatPreference').value;

        if (!url) {
            showError('Vui lòng nhập URL');
            return;
        }

        if (!isValidUrl(url)) {
            showError('URL không hợp lệ');
            return;
        }

        showLoading();
        const response = await fetch('/api/download-subtitle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, platform, targetLanguage, formatPreference })
        });

        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Lỗi tải phụ đề');
        }

        const data = await response.json();
        if (data.error) {
            throw new Error(data.error);
        }

        if (data.downloadUrl) {
            window.location.href = data.downloadUrl;
        }
    } catch (error) {
        showError(error.message);
    } finally {
        hideLoading();
    }
}

async function downloadAllSubtitles() {
    try {
        const url = document.getElementById('url').value;
        const platform = document.getElementById('platform').value;

        if (!url) {
            showError('Vui lòng nhập URL');
            return;
        }

        if (!isValidUrl(url)) {
            showError('URL không hợp lệ');
            return;
        }

        showLoading();
        const response = await fetch('/api/download-all-subtitles', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, platform })
        });

        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Lỗi tải phụ đề');
        }

        const data = await response.json();
        if (data.error) {
            throw new Error(data.error);
        }

        if (data.subtitles && data.subtitles.length > 0) {
            const subtitleList = document.getElementById('subtitleList');
            subtitleList.innerHTML = '';
            data.subtitles.forEach(subtitle => {
                const item = document.createElement('div');
                item.className = 'subtitle-item';
                item.innerHTML = `
                    <span>${subtitle.language} (${subtitle.format})</span>
                    <a href="${subtitle.downloadUrl}" class="download-btn">Tải xuống</a>
                `;
                subtitleList.appendChild(item);
            });
            document.getElementById('subtitleList').style.display = 'block';
        }
    } catch (error) {
        showError(error.message);
    } finally {
        hideLoading();
    }
} 