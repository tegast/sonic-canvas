import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import multer from "multer";
import FormData from "form-data";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_FILE = path.join(__dirname, "history.json");
const KEYS_FILE = path.join(__dirname, "keys.json");
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --- БД Хелперы ---
function getHistory() {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    try { return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8")); } catch (e) { return []; }
}
function saveHistory(data) { fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2)); }

function getKeys() {
    if (!fs.existsSync(KEYS_FILE)) return [];
    try { return JSON.parse(fs.readFileSync(KEYS_FILE, "utf8")); } catch (e) { return []; }
}
function saveKeys(data) { fs.writeFileSync(KEYS_FILE, JSON.stringify(data, null, 2)); }

function updateTaskInDb(taskId, updates) {
    let history = getHistory();
    const index = history.findIndex(item => item.task_id === taskId);
    if (index !== -1) {
        history[index] = { ...history[index], ...updates };
        saveHistory(history);
    } else {
        history.unshift({ task_id: taskId, ...updates });
        saveHistory(history);
    }
}

// --- KEY ROTATION LOGIC (UPDATED) ---
// Теперь принимает userKeys (из заголовка запроса)
async function fetchWithRetry(url, options = {}, userKeys = null) {
    let keys = [];

    // 1. Приоритет: Ключи от клиента (через заголовок)
    if (userKeys) {
        if (typeof userKeys === 'string') {
            // Разбиваем по новой строке или запятой
            keys = userKeys.split(/[\r\n,]+/).map(k => k.trim()).filter(Boolean);
        } else if (Array.isArray(userKeys)) {
            keys = userKeys.map(k => (k || '').trim()).filter(Boolean);
        }
    }

    // 2. Если клиент не прислал, берем с сервера (файл или env)
    if (keys.length === 0) {
        keys = getKeys();
        if (keys.length === 0 && process.env.MUSICAPI_KEY) {
            keys = [process.env.MUSICAPI_KEY];
        }
    }

    if (keys.length === 0) throw new Error("No API keys available (Client didn't send any, Server has none)");

    let lastError = null;

    for (const key of keys) {
        const keyMask = key.slice(0, 5);
        console.log(`[API] Trying key ${keyMask}...`);

        try {
            const headers = { ...options.headers, "Authorization": `Bearer ${key}` };
            const res = await fetch(url, { ...options, headers });

            // Читаем как текст, чтобы не упасть на JSON.parse если там HTML ошибка
            const text = await res.text();
            let data;

            try {
                data = JSON.parse(text);
            } catch (e) {
                console.error(`[API] Key ${keyMask}... returned non-JSON (status ${res.status}): ${text.slice(0, 100)}`);
                // Если статус 4xx/5xx - пробуем следующий ключ, иначе кидаем ошибку
                if (res.status >= 400) continue;
                throw new Error(`Non-JSON response: ${text.slice(0,50)}`);
            }

            // Обработка логических ошибок API (Kie style)
            if (data.code === 401 || data.code === 402 || data.code === 429) {
                console.log(`[API] Key ${keyMask}... returned code ${data.code} (${data.msg}). Switching key...`);
                continue;
            }

            // Особый случай для проверки статуса: иногда возвращает 200 но data null
            if (url.includes("/record-info") && data.code === 200 && !data.data) {
                console.log(`[API] Key ${keyMask}... task not found (data is null). Trying next key...`);
                continue;
            }

            console.log(`[API] Key ${keyMask}... success/valid response.`);
            return data;

        } catch (e) {
            console.error(`[API] Key ${keyMask}... network error:`, e.message);
            lastError = e;
        }
    }

    throw lastError || new Error("All keys failed or task not found on any key");
}

// --- API: Keys Management ---
app.get("/api/keys", (req, res) => {
    const keys = getKeys();
    res.json({ keys: keys, count: keys.length });
});

app.post("/api/keys", (req, res) => {
    try {
        const { keys } = req.body;
        if (!Array.isArray(keys)) return res.status(400).json({ error: "Invalid format" });

        const validKeys = keys.map(k => k.trim()).filter(k => k.length > 0);
        saveKeys(validKeys);
        res.json({ success: true, count: validKeys.length });
    } catch (e) {
        res.status(500).json({ error: "Failed to save keys" });
    }
});

// --- API: Загрузка ---
app.post("/api/upload-file", upload.single("file"), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No file" });
        if (req.file.size > 10 * 1024 * 1024) {
            return res.status(400).json({ error: "File too large (Max 10MB)" });
        }

        const formData = new FormData();
        formData.append("files[]", req.file.buffer, req.file.originalname);

        console.log("Uploading to Uguu.se...");
        const response = await fetch("https://uguu.se/upload.php?output=json", {
            method: "POST",
            body: formData
        });

        const data = await response.json();

        if (!data.success || !data.files || data.files.length === 0) {
            throw new Error(JSON.stringify(data));
        }

        const publicUrl = data.files[0].url;
        console.log("Upload success:", publicUrl);

        res.json({ clip_id: "url_upload", public_url: publicUrl });

    } catch (error) {
        console.error("Upload error:", error);
        res.status(500).json({ error: "Upload failed: " + error.message });
    }
});

// --- API: Генерация (UPDATED) ---
app.post("/api/generate", async (req, res) => {
    try {
        const { mode, task_type, title, tags, prompt, ref_url, options } = req.body;

        // Получаем ключи от клиента
        const clientKeysHeader = req.headers['x-user-keys'] || null;

        const isCover = task_type === 'cover_music';
        const endpoint = isCover
            ? "https://api.kie.ai/api/v1/generate/upload-cover"
            : "https://api.kie.ai/api/v1/generate";

        const body = {
            model: options?.model || "V5",
            callBackUrl: "https://google.com", // Фейковый callback, т.к. мы полим
            customMode: mode === "custom",
            instrumental: options?.instrumental || false
        };

        if (isCover) {
            if (!ref_url) return res.status(400).json({ error: "No reference file" });
            body.uploadUrl = ref_url;
        }

        if (body.customMode) {
            body.title = title || "Untitled";
            body.style = tags || "Pop";
            body.prompt = prompt;

            if (options) {
                if (options.vocal_gender && options.vocal_gender !== 'any') {
                    body.vocalGender = options.vocal_gender === 'male' ? 'm' : 'f';
                }
                if (options.style_influence) body.styleWeight = parseFloat(options.style_influence);
                if (options.weirdness) body.weirdnessConstraint = parseFloat(options.weirdness);

                if (options.negative_tags) body.negativeTags = options.negative_tags;
                if (options.audio_weight) body.audioWeight = parseFloat(options.audio_weight);
                if (options.persona_id) body.personaId = options.persona_id;
            }
        } else {
            body.prompt = prompt;
        }

        // Передаем clientKeysHeader в fetchWithRetry
        const data = await fetchWithRetry(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        }, clientKeysHeader);

        if (data.code === 200 && data.data && data.data.taskId) {
            const newId = data.data.taskId;
            data.task_id = newId;
            data.data.task_id = newId;

            let history = getHistory();

            history.unshift({
                task_id: newId,
                title: body.title || title || "Generating...",
                tags: body.style || tags || "pop",
                prompt: prompt,
                type: task_type,
                status: "submitted",
                created_at: new Date().toISOString(),
                ref_url: ref_url || null,
                metadata: {
                    weirdness: options?.weirdness,
                    style: options?.style_influence,
                    gender: options?.vocal_gender,
                    model: body.model,
                    negative_tags: options?.negative_tags,
                    audio_weight: options?.audio_weight,
                    persona_id: options?.persona_id,
                    instrumental: body.instrumental
                },
                clips: []
            });
            saveHistory(history);
        }
        res.json(data);
    } catch (error) {
        console.error("Gen Error:", error);
        res.status(500).json({ error: "Gen failed: " + error.message });
    }
});

// --- API: Проверка и Sync (UPDATED) ---
app.get("/api/check/:taskId", async (req, res) => {
    // Передаем ключи
    const result = await checkAndSaveTask(req.params.taskId, req.headers['x-user-keys']);
    res.json(result.raw);
});

app.get("/api/history", (req, res) => res.json(getHistory().slice(0, 50)));

app.delete("/api/history/:taskId", (req, res) => {
    let history = getHistory();
    history = history.filter(t => t.task_id !== req.params.taskId);
    saveHistory(history);
    res.json({ success: true });
});

app.post("/api/history/import", async (req, res) => {
    const { taskId } = req.body;
    if (!taskId) return res.status(400).json({ error: "Task ID required" });

    // Передаем ключи
    const result = await checkAndSaveTask(taskId, req.headers['x-user-keys']);

    if (result.raw && result.raw.data && result.raw.data.length > 0) {
        res.json({ success: true, data: result.raw.data[0] });
    } else {
        res.status(404).json({ error: "Task not found or invalid" });
    }
});

app.post("/api/history/refresh", async (req, res) => {
    // Получаем ключи один раз для всей пачки
    const clientKeysHeader = req.headers['x-user-keys'];

    let history = getHistory();
    let count = 0;
    for (const item of history) {
        if (item.status === 'submitted' || item.status === 'failed' || (item.status === 'completed' && (!item.clips || item.clips.length === 0))) {
            // Передаем ключи в проверку
            const r = await checkAndSaveTask(item.task_id, clientKeysHeader);
            if (r.updated) count++;
        }
    }
    res.json({ updated: count, data: getHistory().slice(0, 50) });
});

// (UPDATED) Теперь принимает userKeys
async function checkAndSaveTask(taskId, userKeys = null) {
    try {
        console.log(`Checking task ${taskId.slice(0,8)}...`);

        // Передаем userKeys в fetchWithRetry
        const data = await fetchWithRetry(`https://api.kie.ai/api/v1/generate/record-info?taskId=${taskId}`, {
            method: "GET"
        }, userKeys);

        let updated = false;
        const resultRaw = { code: 200, data: [] };

        if (data && data.code === 200 && data.data) {
            const task = data.data;
            let kieStatus = task.status;
            if (typeof kieStatus === 'string') kieStatus = kieStatus.trim().toUpperCase();

            let state = 'submitted';
            if (['SUCCESS', 'COMPLETED', 'FIRST_SUCCESS'].includes(kieStatus)) {
                state = 'succeeded';
            } else if (['FAILED', 'GENERATE_AUDIO_FAILED', 'CREATE_TASK_FAILED', 'SENSITIVE_WORD_ERROR'].includes(kieStatus)) {
                state = 'failed';
            }

            let rawClips = [];
            const parseIfString = (val) => {
                if (typeof val === 'string') {
                    try { return JSON.parse(val); } catch(e) { return val; }
                }
                return val;
            };

            const parsedResponse = parseIfString(task.response);

            if (Array.isArray(task.sunoData)) {
                rawClips = task.sunoData;
            } else if (parsedResponse && Array.isArray(parsedResponse.sunoData)) {
                rawClips = parsedResponse.sunoData;
            } else if (Array.isArray(parsedResponse)) {
                rawClips = parsedResponse;
            } else if (Array.isArray(task.clips)) {
                rawClips = task.clips;
            }

            const clipsArray = Array.isArray(rawClips) ? rawClips : (rawClips ? [rawClips] : []);

            let metadata = {};
            if (task.param) {
                const p = parseIfString(task.param);
                if (typeof p === 'object') {
                    metadata = {
                        model: p.model,
                        gender: p.vocalGender === 'm' ? 'male' : (p.vocalGender === 'f' ? 'female' : p.vocalGender),
                        style: p.styleWeight,
                        weirdness: p.weirdnessConstraint,
                        audio_weight: p.audioWeight,
                        persona_id: p.personaId,
                        negative_tags: p.negativeTags,
                        instrumental: p.instrumental
                    };
                }
            }

            const foundClips = clipsArray.map((track, index) => ({
                id: track.id || track.audioId || `clip_${index}`,
                url: track.audioUrl || track.audio_url || track.audio,
                image_url: track.imageUrl || track.image_url || track.image,
                video: track.videoUrl || track.video_url || track.video,
                duration: track.duration,
                title: track.title || task.title,
                status: state,
                index: index + 1
            })).filter(c => c.url);

            if (foundClips.length > 0) {
                state = 'succeeded';

                resultRaw.data = foundClips.map(c => ({
                    state: state,
                    clip_id: c.id,
                    audio_url: c.url,
                    image_url: c.image_url,
                    video_url: c.video,
                    duration: c.duration,
                    title: c.title
                }));

                updateTaskInDb(taskId, {
                    status: 'completed',
                    clips: foundClips,
                    title: foundClips[0].title || task.title,
                    metadata: metadata
                });
                updated = true;
            } else if (state === 'succeeded') {
                const failReason = "Generation success but no audio clips found";
                resultRaw.data = [{ state: 'failed', task_id: taskId, error: failReason }];
                updateTaskInDb(taskId, { status: 'failed', error_msg: failReason });
                updated = true;

            } else if (state === 'failed') {
                const failReason = task.failReason || task.error || "Unknown error";
                resultRaw.data = [{ state: 'failed', task_id: taskId, error: failReason }];
                updateTaskInDb(taskId, { status: 'failed', error_msg: failReason });
                updated = true;
            } else {
                resultRaw.data = [{ state: state, task_id: taskId }];
            }
        } else {
            const errMsg = data ? (data.msg || `API Error ${data.code}`) : "Empty response";
            resultRaw.data = [{ state: 'failed', task_id: taskId, error: errMsg }];
        }
        return { raw: resultRaw, updated };
    } catch (e) {
        console.error("Check error:", e);
        return {
            raw: {
                data: [{ state: 'failed', task_id: taskId, error: e.message || "Network Check Failed" }]
            },
            updated: false
        };
    }
}

app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));