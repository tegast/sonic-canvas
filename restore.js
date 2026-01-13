import fs from "fs";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const HISTORY_FILE = "./history.json";
const API_KEY = process.env.MUSICAPI_KEY;

async function restoreLinks() {
    console.log("🔄 Запуск восстановления ссылок (v2 - Array Fix)...");

    if (!API_KEY) return console.error("❌ ОШИБКА: Нет MUSICAPI_KEY в .env");
    if (!fs.existsSync(HISTORY_FILE)) return console.log("❌ Файл history.json не найден!");

    let history = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    let updatedCount = 0;

    for (let i = 0; i < history.length; i++) {
        const item = history[i];

        // Проверяем, если ссылки нет
        if (!item.audio_url) {
            try {
                console.log(`📡 Запрос ID: ${item.task_id}...`);

                const response = await fetch(`https://api.musicapi.ai/api/v1/sonic/task/${item.task_id}`, {
                    method: "GET",
                    headers: {
                        "Authorization": `Bearer ${API_KEY}`,
                        "Content-Type": "application/json"
                    }
                });

                const json = await response.json();

                // ИСПРАВЛЕНИЕ: Проверяем, что data - это массив и в нем есть элементы
                if (json.code === 200 && Array.isArray(json.data) && json.data.length > 0) {

                    // Берем первый трек из вариантов (обычно их 2)
                    const track = json.data[0];

                    if (track.audio_url) {
                        history[i].audio_url = track.audio_url;
                        history[i].duration = track.duration;
                        history[i].title = track.title || history[i].title;
                        history[i].tags = track.tags || history[i].tags;

                        // Меняем статус на понятный нашему фронтенду
                        // API отдает "succeeded", а фронт ждет "completed"
                        if (track.state === 'succeeded') {
                            history[i].status = 'completed';
                        }

                        console.log(`✅ УСПЕХ! Ссылка найдена: ${track.audio_url.slice(0, 30)}...`);
                        updatedCount++;
                    }
                } else {
                    console.log(`⚠️ Пустой ответ или ошибка для ${item.task_id}`);
                }

            } catch (e) {
                console.error(`❌ Ошибка сети:`, e.message);
            }
        }
    }

    if (updatedCount > 0) {
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
        console.log(`\n🎉 Сохранено ${updatedCount} треков! Обнови страницу в браузере.`);
    } else {
        console.log("\n🤷 Новых ссылок не найдено.");
    }
}

restoreLinks();