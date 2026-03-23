export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  let body = req.body;

  // На Vercel тело может быть строкой — пробуем распарсить
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (e) {
      return res.status(400).send("Bad Request");
    }
  }

  const CONFIRMATION_CODE = "4d476332";
  const VK_SECRET = "kP7sY9q3Wm2Zf8R1tL4vB6nC0xD5gH7jK9pM2rT8";

  const { type, secret } = body || {};

  // проверка, что запрос реально от VK (секрет должен совпадать)
  if (secret && secret !== VK_SECRET) {
    return res.status(403).send("forbidden");
  }

  if (type === "confirmation") {
    // ВАЖНО: вернуть ровно строку, без JSON
    res.status(200).setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.send(CONFIRMATION_CODE);
  }

  // остальные события
  res.status(200).setHeader("Content-Type", "text/plain; charset=utf-8");
  return res.send("ok");
}
