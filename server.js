
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json({ limit: "100kb" }));

const PORT = process.env.PORT || 3000;
const USER_ID = process.env.JSONSTORAGE_USER_ID;
const ITEM_ID = process.env.JSONSTORAGE_ITEM_ID;
const API_KEY = process.env.JSONSTORAGE_API_KEY;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

const DB_URL =
  `https://api.jsonstorage.net/v1/json/${USER_ID}/${ITEM_ID}`;

async function readDB() {
  const response = await fetch(DB_URL);
  if (!response.ok) throw new Error("Database read failed");
  return await response.json();
}

async function writeDB(data) {
  const response = await fetch(
    `${DB_URL}?apiKey=${encodeURIComponent(API_KEY)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    }
  );

  if (!response.ok) throw new Error("Database write failed");
}

function adminOnly(req, res, next) {
  if (req.headers.authorization !== `Bearer ${ADMIN_TOKEN}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

app.get("/api/health", (req, res) => {
  res.json({ status: "online" });
});

// Member submits a voluntarily shared location report.
app.post("/api/location", async (req, res) => {
  try {
    const { deviceId, deviceName, latitude, longitude, consent } = req.body;

    if (!consent || !deviceId || !deviceName ||
        !Number.isFinite(latitude) || !Number.isFinite(longitude) ||
        latitude < -90 || latitude > 90 ||
        longitude < -180 || longitude > 180) {
      return res.status(400).json({ error: "Invalid report or missing consent" });
    }

    const db = await readDB();

    db.devices ||= [];
    db.location_reports ||= [];
    db.notifications ||= [];

    const now = new Date().toISOString();

    let device = db.devices.find(d => d.id === deviceId);

    if (!device) {
      device = { id: deviceId, name: deviceName };
      db.devices.push(device);
    }

    device.name = deviceName;
    device.status = "Online";
    device.consent = true;
    device.last_seen = now;

    db.location_reports.push({
      device_id: deviceId,
      device_name: deviceName,
      latitude,
      longitude,
      timestamp: now
    });

    db.notifications.push({
      title: "Laporan lokasi diterima",
      message: `${deviceName} membagikan lokasi`,
      timestamp: now
    });

    await writeDB(db);

    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to save report" });
  }
});

// Admin-only database read.
app.get("/api/admin/data", adminOnly, async (req, res) => {
  try {
    res.json(await readDB());
  } catch (error) {
    res.status(500).json({ error: "Database read failed" });
  }
});

// Admin stops sharing for a device.
app.post("/api/admin/stop-sharing", adminOnly, async (req, res) => {
  try {
    const db = await readDB();
    const device = (db.devices || []).find(
      d => d.id === req.body.deviceId
    );

    if (!device) return res.status(404).json({ error: "Device not found" });

    device.consent = false;
    device.status = "Sharing stopped";

    await writeDB(db);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Update failed" });
  }
});

app.listen(PORT, () => {
  console.log(`Family Safety API running on ${PORT}`);
});
