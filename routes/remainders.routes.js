import express from "express";
import User from "../models/User.js";
import { calculateReminderTimes } from "../utils/scheduler.js";
import { sendWhatsAppMessage } from "../utils/twilio.js";

const router = express.Router();

router.post("/register", async (req, res) => {
  const { phoneNumber, wakeTime, sleepTime, prescription } = req.body;

  const user = await User.findOneAndUpdate(
    { phoneNumber },
    {
      wakeTime,
      sleepTime,
      precription: prescription,
      notificationsEnabled: true,
      flowStep: "completed",
    },
    { upsert: true, new: true }
  );

  const reminderTimes = calculateReminderTimes(
    wakeTime,
    sleepTime,
    prescription.timesToTake
  );

  res.json({ message: "User registered", reminderTimes });
});

router.post("/optout", async (req, res) => {
  const { phoneNumber } = req.body;
  await User.findOneAndUpdate({ phoneNumber }, { notificationsEnabled: false });
  res.json({ message: "Opted out of reminders" });
});

router.post("/resume", async (req, res) => {
  const { phoneNumber } = req.body;
  const user = await User.findOneAndUpdate(
    { phoneNumber },
    { notificationsEnabled: true }
  );

  const reminderTimes = calculateReminderTimes(
    user.wakeTime,
    user.sleepTime,
    user.precription.timesToTake
  );

  res.json({ message: "Resumed reminders", reminderTimes });
});
