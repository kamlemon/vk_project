import express from "express";
import bodyParser from "body-parser";

const app = express();
app.use(bodyParser.json());

const CONFIRMATION_CODE = "4d476332";
const VK_SECRET = "kP7sY9q3Wm2Zf8R1tL4vB6nC0xD5gH7jK9pM2rT8";

app.post("/", (req, res) => {
  const { type, secret } = req.body || {};

  // проверяем, точно ли запрос от VK
  if (secret && secret !== VK_SECRET) {
    return res.status(403).send("forbidden");
  }

  if (type === "confirmation") {
    // первый запрос подтверждения
    return res.send(CONFIRMATION_CODE);
  }

  // здесь потом будешь обрабатывать события (message_new и т.д.)
  // пока просто отвечаем ok, чтобы VK не ругался
  return res.send("4d476332");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("VK callback server started on port", PORT);
});
