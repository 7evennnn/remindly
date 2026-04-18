import 'dotenv/config';
import express from 'express';
import { handleUpdate, startPolling, setWebhook } from './bot.js';
import './scheduler.js';

const app = express();
app.use(express.json());

app.get('/', (req, res) => res.send('Remindly is running ✅'));

// Telegram sends updates here in production
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // always ack first
  await handleUpdate(req.body).catch(console.error);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server on port ${PORT}`);

  if (process.env.NODE_ENV === 'production' && process.env.WEBHOOK_URL) {
    await setWebhook(`${process.env.WEBHOOK_URL}/webhook`);
  } else {
    startPolling(); // no ngrok needed locally
  }
});