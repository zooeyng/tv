// ============ 全局狀態 ============
let audioContext = null;
let ws = null;
let mediaStream = null;
let scriptProcessor = null;
let playbackNode = null;
let audioQueue = [];
let nextPlayTime = 0;
let isServerMode = false;
let isConnected = false;
let audioDevices = [];
let selectedDeviceId = '';
let analyser = null;
let meterInterval = null;

// ============ 頁面切換 ============
document.querySelectorAll('.sidebar-item').forEach(item => {
    item.addEventListener('click', () => {
        document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        item.classList.add('active');
        const pageId = 'page-' + item.dataset.page;
        document.getElementById(pageId).classList.add('active');
        
        // 播放器頁面顯示右側面板，其他頁面隱藏
        document.getElementById('right-panel').style.display = item.dataset.page === 'player' ? 'block' : 'none';
    });
});

function hidePlayerIntro() {
    // 點擊叉號不關閉，和原軟件一致
}

// ============ 模式選擇 ============
let currentMode = 'playback';
function selectMode(mode) {
    currentMode = mode;
    document.querySelectorAll('.radio-item').forEach(r => r.classList.remove('checked'));
    if (mode === 'playback') {
        document.getElementById('radio-playback').classList.add('checked');
        document.getElementById('opt-playback').style.background = '#f0f7ff';
        document.getElementById('opt-mic').style.background = 'transparent';
    } else {
        document.getElementById('radio-mic').classList.add('checked');
        document.getElementById('opt-mic').style.background = '#f0f7ff';
        document.getElementById('opt-playback').style.background = 'transparent';
    }
}
selectMode('playback');

// ============ 自動檢測本機伺服器 ============
async function detectLocalServer() {
    try {
        const protocol = location.protocol === 'https:' ? 'https:' : 'http:';
        const resp = await fetch(`${protocol}//${window.location.hostname}:8080/api/info`, { timeout: 2000 });
        if (resp.ok) {
            const info = await resp.json();
            document.getElementById('discovered-server').style.display = 'flex';
            document.getElementById('local-server-name').textContent = info.name;
            document.getElementById('local-server-ip').textContent = info.ip;
            document.getElementById('server-ip').value = info.ip;
        }
    } catch(e) {
        // 不在本機環境，不顯示
    }
}
detectLocalServer();

// ============ 獲取音頻輸出設備列表 ============
async function loadAudioDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    audioDevices = devices.filter(d => d.kind === 'audiooutput');
    
    if (audioDevices.length > 1) {
        const names = audioDevices.map((d, i) => `${i+1}. ${d.label || '裝置 ' + (i+1)}`).join('\n');
        const idx = prompt(`選擇音訊播放裝置：\n${names}\n\n請輸入編號：`, '1');
        if (idx && audioDevices[idx-1]) {
            selectedDeviceId = audioDevices[idx-1].deviceId;
            document.getElementById('selected-device').textContent = audioDevices[idx-1].label || '裝置 ' + idx;
        }
    } else {
        alert('目前只有一個可用的音訊輸出裝置');
    }
}

// ============ 客戶端：連接伺服器並播放 ============
async function connectServer() {
    const ipInput = document.getElementById('server-ip').value.trim();
    if (!ipInput) {
        showStatus('error', '請輸入伺服器IP位址');
        return;
    }

    if (isConnected) {
        // 斷開連接
        disconnect();
        return;
    }

    showStatus('connecting', '正在連接伺服器...');
    document.getElementById('connect-btn').disabled = true;

    try {
        // 確定協議：如果頁面是https就用wss，否則ws
        const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = ipInput.startsWith('ws') ? ipInput : `${wsProtocol}//${ipInput}:8443`;
        ws = new WebSocket(wsUrl);
        ws.binaryType = 'arraybuffer';

        ws.onopen = async () => {
            // 告訴伺服器我是播放器
            ws.send(JSON.stringify({type: 'player', mode: currentMode}));
            
            // 初始化音頻上下文
            if (!audioContext) {
                audioContext = new (window.AudioContext || window.webkitAudioContext)({
                    sampleRate: parseInt(document.getElementById('sample-rate').value)
                });
            }
            if (audioContext.state === 'suspended') {
                await audioContext.resume();
            }
            
            // 音量分析
            analyser = audioContext.createAnalyser();
            analyser.fftSize = 256;
            const dataArray = new Uint8Array(analyser.frequencyBinCount);
            document.getElementById('meter-container').classList.add('active');
            
            meterInterval = setInterval(() => {
                analyser.getByteFrequencyData(dataArray);
                let sum = 0;
                for(let i = 0; i < dataArray.length; i++) sum += dataArray[i];
                const avg = sum / dataArray.length;
                document.getElementById('meter-fill').style.width = Math.min(100, avg/256*150) + '%';
            }, 50);

            isConnected = true;
            showStatus('connected', '✅ 已連接，正在接收音訊...');
            document.getElementById('connect-btn').textContent = '斷開連線';
            document.getElementById('connect-btn').disabled = false;
            
            // 初始化緩衝區
            audioQueue = [];
            nextPlayTime = audioContext.currentTime + 0.1;
            schedulePlayback();
        };

        ws.onmessage = (event) => {
            if (event.data instanceof ArrayBuffer) {
                // 收到PCM數據
                const bufferSize = parseInt(document.getElementById('buffer-ms').value) / 1000 * audioContext.sampleRate * 2;
                audioQueue.push(event.data);
                if (audioQueue.length > 10) audioQueue.shift(); // 防止緩衝過多
            }
        };

        ws.onerror = () => {
            showStatus('error', '❌ 連接失敗，請檢查IP、端口和網絡');
            document.getElementById('connect-btn').disabled = false;
        };

        ws.onclose = () => {
            disconnect();
        };

    } catch(err) {
        showStatus('error', '❌ 連接出錯：' + err.message);
        document.getElementById('connect-btn').disabled = false;
    }
}

// ============ PCM播放邏輯 ============
function schedulePlayback() {
    if (!isConnected || !audioContext) return;

    const bufferDuration = 0.05; // 每次播放50ms
    while (audioQueue.length > 0 && nextPlayTime < audioContext.currentTime + 0.5) {
        const rawData = audioQueue.shift();
        const int16 = new Int16Array(rawData);
        const float32 = new Float32Array(int16.length);
        
        for (let i = 0; i < int16.length; i++) {
            float32[i] = int16[i] / 32768;
        }

        const channelCount = parseInt(document.getElementById('channels').value);
        const frameCount = float32.length / channelCount;
        const audioBuffer = audioContext.createBuffer(channelCount, frameCount, audioContext.sampleRate);
        
        for (let ch = 0; ch < channelCount; ch++) {
            const channelData = audioBuffer.getChannelData(ch);
            for (let i = 0; i < frameCount; i++) {
                channelData[i] = float32[i * channelCount + ch];
            }
        }

        const source = audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(analyser);
        analyser.connect(audioContext.destination);
        
        // 如果選擇了特定輸出設備
        if (selectedDeviceId && source.setSinkId) {
            source.setSinkId(selectedDeviceId);
        }
        
        source.start(nextPlayTime);
        nextPlayTime += bufferDuration;
    }

    requestAnimationFrame(schedulePlayback);
}

// ============ 客戶端/伺服器通用：斷開連接 ============
function disconnect() {
    isConnected = false;
    if (ws) {
        ws.close();
        ws = null;
    }
    if (mediaStream) {
        mediaStream.getTracks().forEach(t => t.stop());
        mediaStream = null;
    }
    if (scriptProcessor) {
        scriptProcessor.disconnect();
        scriptProcessor = null;
    }
    if (meterInterval) {
        clearInterval(meterInterval);
        meterInterval = null;
    }
    document.getElementById('connect-btn').textContent = '連線';
    document.getElementById('server-toggle-btn').textContent = '🎙️ 啟動伺服器並開始發送音頻';
    document.getElementById('meter-container').classList.remove('active');
    showStatus('', '');
    document.getElementById('server-status').className = 'server-status stopped';
    document.getElementById('server-status').innerHTML = '目前伺服器已關閉<br>點擊上方按鈕啟動';
    audioQueue = [];
}

// ============ 伺服器模式：採集音頻並發送 ============
async function toggleServer() {
    if (isConnected) {
        disconnect();
        return;
    }

    try {
        // 請求麥克風權限，無壓縮採集
        const constraints = {
            audio: {
                sampleRate: parseInt(document.getElementById('sample-rate').value),
                channelCount: parseInt(document.getElementById('channels').value),
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false, // 完全關閉處理，保留原始音質
            }
        };

        mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
        
        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: parseInt(document.getElementById('sample-rate').value)
            });
        }
        if (audioContext.state === 'suspended') {
            await audioContext.resume();
        }

        const source = audioContext.createMediaStreamSource(mediaStream);
        
        // 使用ScriptProcessor採集原始PCM
        const bufferSize = 2048;
        scriptProcessor = audioContext.createScriptProcessor(bufferSize, parseInt(document.getElementById('channels').value), parseInt(document.getElementById('channels').value));
        
        scriptProcessor.onaudioprocess = (e) => {
            if (!isConnected || !ws || ws.readyState !== WebSocket.OPEN) return;
            
            const channels = parseInt(document.getElementById('channels').value);
            const channelData = [];
            for (let ch = 0; ch < channels; ch++) {
                channelData.push(e.inputBuffer.getChannelData(ch));
            }
            
            // 轉成16bit PCM
            const int16Data = new Int16Array(bufferSize * channels);
            for (let i = 0; i < bufferSize; i++) {
                for (let ch = 0; ch < channels; ch++) {
                    let sample = channelData[ch][i];
                    sample = Math.max(-1, Math.min(1, sample));
                    int16Data[i * channels + ch] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
                }
            }
            
            ws.send(int16Data.buffer);
        };

        source.connect(scriptProcessor);
        scriptProcessor.connect(audioContext.destination);

        // 連接本機的伺服器中繼（由server.js轉發給播放器）
        const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(`${wsProtocol}//${window.location.host}`);
        ws.binaryType = 'arraybuffer';
        
        ws.onopen = () => {
            ws.send(JSON.stringify({
                type: 'server',
                sampleRate: audioContext.sampleRate,
                channels: parseInt(document.getElementById('channels').value),
                bitDepth: parseInt(document.getElementById('bit-depth').value)
            }));
            
            isConnected = true;
            isServerMode = true;
            document.getElementById('server-toggle-btn').textContent = '⏹️ 停止伺服器';
            document.getElementById('server-status').className = 'server-status running';
            document.getElementById('server-status').innerHTML = `
                ✅ 伺服器已啟動，音頻採集中<br>
                🎵 音質：${audioContext.sampleRate/1000}kHz / ${document.getElementById('bit-depth').value}bit / ${document.getElementById('channels').value}聲道<br>
                🌐 等待其他設備連線，請在播放器端輸入本機IP位址
            `;
        };

        ws.onclose = ws.onerror = () => {
            disconnect();
        };

    } catch(err) {
        alert('無法啟動音頻採集：' + err.message + '\n請確認已授予麥克風權限');
        disconnect();
    }
}

// ============ 狀態顯示 ============
function showStatus(type, text) {
    const bar = document.getElementById('status-bar');
    bar.className = 'status-bar ' + type;
    bar.textContent = text;
}

// 預設伺服器IP提示
if (location.hostname !== 'localhost' && !location.hostname.includes('github.io')) {
    document.getElementById('server-ip').placeholder = location.hostname;
}
