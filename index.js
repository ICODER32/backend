import express from "express";
import { configDotenv } from "dotenv";
import dbConnect from "./config/db.js";
import PharmacyRoutes from "./routes/pharma.routes.js";
import userRoutes from "./routes/user.routes.js";
import loginRoutes from "./routes/login.routes.js";
import careGiverRoutes from "./routes/careGivers.routes.js";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import {
  startReminderCron,
  startReminderFollowupCron,
} from "./cron-jobs/cronScheduler.js";
import cookieParser from "cookie-parser";
import cors from "cors";

// Load environment variables
configDotenv();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(express.static(path.join(__dirname, "dist")));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
// app.use(
//   cors({
//     origin: "http://localhost:5173", // Vite dev server
//     credentials: true,
//   })
// );

// Routes
console.log("Registering routes...");

app.use("/api/pharmacy", PharmacyRoutes);
app.use("/api/user", userRoutes);
app.use("/api/login", loginRoutes);
app.use("/api/caregivers", careGiverRoutes);

console.log("Routes registered.");

// Start the server and crons
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  dbConnect();
  startReminderCron();
  startReminderFollowupCron();
  console.log("Reminder cron jobs started");
});
