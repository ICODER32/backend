import express from "express";
import User from "../models/user.model.js";
import { configDotenv } from "dotenv";
import twilio from "twilio";
import {
  calculateReminderTimes,
  generateMedicationSchedule,
} from "../utils/scheduler.js";
import cron from "node-cron";
import moment from "moment";
import { DateTime } from "luxon";
import momenttimezone from "moment-timezone";

configDotenv();
const router = express.Router();
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Background job for check-ins
cron.schedule("0 1 * * *", async () => {
  const inactiveUsers = await User.find({
    status: "paused",
    "tracking.optOutDate": {
      $lte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    },
  });

  for (const user of inactiveUsers) {
    await sendMessage(
      user.phoneNumber,
      `Hi! Would you like to resume your medication reminders? Reply RESUME to continue.`
    );
  }
});

// SMS Reply Handler
router.post("/sms/reply", async (req, res) => {
  const from = req.body.From;
  const msg = req.body.Body?.trim();
  console.log(`Received message from ${from}: ${msg}`);

  if (!from || !msg) return res.sendStatus(400);

  const phone = from.replace("+", "");
  let user = await User.findOne({ phoneNumber: phone });

  if (!user) {
    return sendMessage(
      phone,
      "You are not registered with any medications. Please contact your pharmacy."
    );
  }

  if (!user.temp) {
    user.temp = {};
  }
  // UPDATE TIME ZONE
  const stateTimezones = {
    AL: "America/Chicago", // Alabama – Central
    AK: "America/Anchorage", // Most of Alaska (excluding Aleutian Islands)
    AZ: "America/Phoenix", // Arizona – no DST except Navajo Nation
    AR: "America/Chicago", // Arkansas
    CA: "America/Los_Angeles", // California
    CO: "America/Denver", // Colorado
    CT: "America/New_York", // Connecticut
    DE: "America/New_York", // Delaware
    DC: "America/New_York", // District of Columbia
    FL: "America/New_York", // Florida – majority Eastern (some Panhandle in Central)
    GA: "America/New_York", // Georgia
    HI: "Pacific/Honolulu", // Hawaii – no DST
    ID: "America/Boise", // Idaho – mostly Mountain (some Panhandle in Pacific)
    IL: "America/Chicago", // Illinois
    IN: "America/Indiana/Indianapolis", // Indiana – Eastern majority (some counties in Central)
    IA: "America/Chicago", // Iowa
    KS: "America/Chicago", // Kansas – majority Central (some w. counties in Mountain)
    KY: "America/New_York", // Kentucky – major Eastern (Western KY in Central)
    LA: "America/Chicago", // Louisiana
    ME: "America/New_York", // Maine
    MD: "America/New_York", // Maryland
    MA: "America/New_York", // Massachusetts
    MI: "America/Detroit", // Michigan – majority Eastern (Upper Peninsula western counties in Central)
    MN: "America/Chicago", // Minnesota
    MS: "America/Chicago", // Mississippi
    MO: "America/Chicago", // Missouri
    MT: "America/Denver", // Montana
    NE: "America/Chicago", // Nebraska – majority Central (western in Mountain)
    NV: "America/Los_Angeles", // Nevada – majority Pacific, some in Mountain (e.g., West Wendover)
    NH: "America/New_York", // New Hampshire
    NJ: "America/New_York", // New Jersey
    NM: "America/Denver", // New Mexico
    NY: "America/New_York", // New York
    NC: "America/New_York", // North Carolina
    ND: "America/Chicago", // North Dakota – majority Central (west border counties in Mountain)
    OH: "America/New_York", // Ohio
    OK: "America/Chicago", // Oklahoma – almost entirely Central
    OR: "America/Los_Angeles", // Oregon – majority Pacific (some eastern regions in Mountain)
    PA: "America/New_York", // Pennsylvania
    RI: "America/New_York", // Rhode Island
    SC: "America/New_York", // South Carolina
    SD: "America/Chicago", // South Dakota – majority Central (western in Mountain)
    TN: "America/Chicago", // Tennessee – majority Central (East TN in Eastern)
    TX: "America/Chicago", // Texas – majority Central (West Texas in Mountain)
    UT: "America/Denver", // Utah
    VT: "America/New_York", // Vermont
    VA: "America/New_York", // Virginia
    WA: "America/Los_Angeles", // Washington state
    WV: "America/New_York", // West Virginia
    WI: "America/Chicago", // Wisconsin
    WY: "America/Denver",
  };
  if (req.body.FromState && stateTimezones[req.body.FromState]) {
    user.timezone = stateTimezones[req.body.FromState];
  } else {
    user.timezone = "Asia/Karachi";
  }

  await user.save();

  const lowerMsg = msg.toLowerCase();
  let reply = "";
  let additionalMessage = null;
  let handled = false;
  const now = new Date();

  // Handle special commands
  if (lowerMsg === "h" || lowerMsg === "help") {
    reply = `Commands:\n\nT – set time\nD – confirm taken\nS – skip dose\nSTOP – stop reminders\nPAUSE - Doctor Advice or Breaks\nREMINDER- Continue after STOP\nRESUME Continue after PAUSE\nCANCEL - cancel reminders\nFor Dashboard, visit ${process.env.DASHBOARD_LINK}`;
    handled = true;
  }

  if (lowerMsg === "d") {
    const pendingNotifications = user.notificationHistory
      .filter((n) => n.status === "pending")
      .sort((a, b) => b.sentAt - a.sentAt);

    if (pendingNotifications.length === 0) {
      const missedNotifications = user.notificationHistory
        .filter((n) => n.status === "skipped")
        .sort((a, b) => b.sentAt - a.sentAt);

      if (missedNotifications.length > 0) {
        const lastMissed = missedNotifications[0];
        const missedMeds = lastMissed.medications.join(", ");
        const missedTime = new Date(lastMissed.sentAt).toLocaleTimeString(
          "en-US",
          {
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
          }
        );

        reply = `You don't have any pending medications to confirm.\nYour ${missedMeds} dose at ${missedTime} was already marked as missed.`;
      } else {
        reply = "You don't have any pending medications to confirm.";
      }
      handled = true;
    } else {
      const mostRecentNotification = pendingNotifications[0];
      mostRecentNotification.status = "taken";

      // Update ALL linked schedule items
      mostRecentNotification.scheduleIds.forEach((scheduleId) => {
        const scheduleItem = user.medicationSchedule.id(scheduleId);
        if (scheduleItem && scheduleItem.status === "pending") {
          scheduleItem.status = "taken";
          scheduleItem.takenAt = now;

          // Update prescription counts
          const prescription = user.prescriptions.id(
            scheduleItem.prescriptionId
          );
          if (prescription) {
            prescription.tracking.pillCount = Math.max(
              0,
              prescription.tracking.pillCount - prescription.dosage
            );
            prescription.tracking.dailyConsumption += prescription.dosage;
          }
        }
      });

      reply = `Confirmed! You've taken your medications.`;
      handled = true;
    }
  }
  if (!handled && lowerMsg === "s") {
    const pendingNotifications = user.notificationHistory
      .filter((n) => n.status === "pending")
      .sort((a, b) => b.sentAt - a.sentAt);

    if (pendingNotifications.length === 0) {
      reply = "You don't have any pending medications to skip.";
      handled = true;
    } else {
      const mostRecentNotification = pendingNotifications[0];
      mostRecentNotification.scheduleIds.forEach((scheduleId) => {
        const scheduleItem = user.medicationSchedule.id(scheduleId);
        if (scheduleItem && scheduleItem.status === "pending") {
          scheduleItem.status = "skipped";

          // Update prescription tracking
          const prescription = user.prescriptions.id(
            scheduleItem.prescriptionId
          );
          if (prescription) {
            prescription.tracking.skippedCount += 1;
          }
        }
      });

      reply = `Skipped! You chose to skip your medications: ${mostRecentNotification.medications.join(
        ", "
      )}.`;
      handled = true;
    }
  }

  if (lowerMsg === "stop") {
    user.status = "inactive";
    user.notificationsEnabled = false;
    user.prescriptions.forEach((p) => {
      p.remindersEnabled = false;
    });

    user.flowStep = "done";

    await user.save(); // Save immediately after updating status
    reply =
      "Reminders stopped for all medications. You can resume anytime by texting REMINDER.";
  }

  // resume
  if (!handled && lowerMsg === "resume") {
    if (user.status === "inactive") {
      user.status = "active";
      user.notificationsEnabled = true;
      user.prescriptions.forEach((p) => {
        p.remindersEnabled = true;
      });
    }
  }

  if (!handled && (lowerMsg === "t" || lowerMsg === "set time")) {
    const enabledMeds = user.prescriptions.filter((p) => p.remindersEnabled);

    if (enabledMeds.length === 0) {
      reply = "You don't have any active medications. Enable reminders first.";
      handled = true;
    } else {
      const userTimezone = user.timezone || "UTC";
      const medList = enabledMeds
        .map((p, i) => {
          const medTimes = user.medicationSchedule
            .filter((item) => item.prescriptionName === p.name)
            .map((item) =>
              moment(item.scheduledTime).tz(userTimezone).format("h:mm A")
            );

          const uniqueTimes = [...new Set(medTimes)];
          return `${i + 1}. ${p.name} (Current times: ${
            uniqueTimes.join(", ") || "not set"
          })`;
        })
        .join("\n");

      reply = `Which pill would you like to set a custom time for?\nReply with a number:\n${medList}\n(Type the number of the pill you want to change.)`;
      user.flowStep = "set_time_select_med";
      user.temp = {};
      await user.save();
      handled = true;
    }
  }

  if (!handled && lowerMsg === "pause") {
    user.status = "paused";
    user.tracking.optOutDate = now;
    user.prescriptions.forEach((p) => {
      p.remindersEnabled = false;
    });
    user.medicationSchedule = [];
    reply = "Reminders paused for all medications. Text RESUME to resume.";
    handled = true;
  }

  if (!handled && lowerMsg === "resume") {
    if (user.status === "paused") {
      user.status = "active";
      user.notificationsEnabled = true;
      user.prescriptions.forEach((p) => {
        p.remindersEnabled = true;
      });

      const enabledMeds = user.prescriptions.filter((p) => p.remindersEnabled);
      const allReminders = enabledMeds.flatMap((p) => {
        return calculateReminderTimes(
          user.wakeTime,
          user.sleepTime,
          p.instructions,
          p.timesToTake,
          p.name,
          p.tracking.pillCount,
          p.dosage
        ).map((r) => ({
          time: r.time,
          prescriptionName: p.name,
          prescriptionId: p._id, // CRITICAL: Add prescription ID
          pillCount: p.tracking.pillCount,
          dosage: p.dosage,
        }));
      });

      const uniqueReminders = Array.from(
        new Map(
          allReminders.map((r) => [`${r.prescriptionName}-${r.time}`, r])
        ).values()
      );

      uniqueReminders.sort(
        (a, b) => moment(a.time, "HH:mm") - moment(b.time, "HH:mm")
      );

      user.reminderTimes = uniqueReminders.map((r) => r.time);

      user.medicationSchedule = generateMedicationSchedule(
        uniqueReminders,
        user.timezone
      );
      user.flowStep = "done";

      reply = "Reminders resumed for all medications!";
    } else {
      reply = "Reminders are already active!";
    }
    handled = true;
  }

  // Conversation flow
  if (!handled) {
    switch (user.flowStep) {
      case "init":
        if (user.prescriptions.length === 0) {
          reply =
            "You are not registered with any medications. Please contact your pharmacy.";
          user.flowStep = "done";
        } else {
          const medList = user.prescriptions
            .map((p, i) => `${i + 1}. ${p.name}`)
            .join("\n");

          reply = `Welcome to CareTrackRX! We've registered:\n${medList}\n\nWhich medications would you like reminders for? Reply with numbers separated by commas (e.g., 1,3) or N to skip.`;
          user.flowStep = "ask_reminders";
        }
        break;

      case "ask_reminders":
        // Handle negative response
        if (msg.match(/^(n|no)$/i)) {
          user.prescriptions.forEach((p) => {
            p.remindersEnabled = false;
          });
          user.status = "inactive";
          user.flowStep = "done";
          reply =
            "Thank you! Please continue to watch your medication intake.\nYou can return to CareTrackRX anytime by texting the word REMINDER.";
        } else {
          // Process medication selection
          const selected = msg
            .split(",")
            .map((num) => parseInt(num.trim()))
            .filter(
              (num) =>
                !isNaN(num) && num > 0 && num <= user.prescriptions.length
            );

          if (selected.length === 0) {
            reply =
              "Okay, we won't send any reminders. You can enable them later by texting REMINDERS.";
            user.flowStep = "done";
            user.status = "inactive";
          } else {
            user.prescriptions.forEach((prescription, index) => {
              prescription.remindersEnabled = selected.includes(index + 1);
            });

            const needInstructions = user.prescriptions.some(
              (p) => p.remindersEnabled && !p.instructions
            );

            if (needInstructions) {
              reply =
                "Do you have any special instructions for these medications? (e.g., 'Take with food', 'Before bed')";
              user.flowStep = "ask_instructions";
            } else {
              reply = "What time do you usually wake up? (e.g., 7 AM)";
              user.flowStep = "ask_wake_time";
            }
          }
        }
        break;

      case "ask_instructions":
        user.prescriptions.forEach((p) => {
          if (p.remindersEnabled && !p.instructions) {
            p.instructions = msg;
          }
        });

        reply = "What time do you usually wake up? (e.g., 7 AM)";
        user.flowStep = "ask_wake_time";
        break;

      case "ask_wake_time":
        if (validateTime(msg, "morning")) {
          user.wakeTime = parseTime(msg);
          reply =
            "Great! Now, what time do you usually go to sleep? (e.g., 10 PM)";
          user.flowStep = "ask_sleep_time";
        } else {
          reply = "Please enter a valid morning time (e.g., 7 AM)";
        }
        break;

      case "ask_sleep_time":
        if (validateTime(msg, "night")) {
          user.sleepTime = parseTime(msg);

          const enabledMeds = user.prescriptions.filter(
            (p) => p.remindersEnabled
          );

          const allReminders = enabledMeds.flatMap((p) => {
            return calculateReminderTimes(
              user.wakeTime,
              user.sleepTime,
              p.instructions,
              p.timesToTake,
              p.name,
              p.tracking.pillCount,
              p.dosage
            ).map((r) => ({
              time: r.time,
              prescriptionName: p.name,
              pillCount: p.tracking.pillCount,
              dosage: p.dosage,
            }));
          });

          const uniqueReminders = Array.from(
            new Map(
              allReminders.map((r) => [`${r.prescriptionName}-${r.time}`, r])
            ).values()
          );

          uniqueReminders.sort(
            (a, b) => moment(a.time, "HH:mm") - moment(b.time, "HH:mm")
          );

          user.reminderTimes = uniqueReminders.map((r) => r.time);
          user.medicationSchedule = generateMedicationSchedule(
            uniqueReminders,
            user.timezone
          );
          user.status = "active";
          user.notificationsEnabled = true;
          user.flowStep = "done";

          // Group medications by time and format the message
          const groupedByTime = {};
          uniqueReminders.forEach((reminder) => {
            const time12h = moment(reminder.time, "HH:mm").format("h:mm A");
            if (!groupedByTime[time12h]) {
              groupedByTime[time12h] = [];
            }
            groupedByTime[time12h].push(reminder.prescriptionName);
          });

          // Group medications by name for the alternative format
          const groupedByMed = {};
          uniqueReminders.forEach((reminder) => {
            const medName = reminder.prescriptionName;
            const time12h = moment(reminder.time, "HH:mm").format("h:mm A");
            if (!groupedByMed[medName]) {
              groupedByMed[medName] = [];
            }
            groupedByMed[medName].push(time12h);
          });

          // Create the formatted message
          let medicationList = [];
          for (const [medName, times] of Object.entries(groupedByMed)) {
            medicationList.push(`${medName} at ${times.join(", ")}`);
          }

          const formattedSchedule = medicationList.join("; ");

          reply = `Great! You'll get reminders for:\n${formattedSchedule}.`;
          additionalMessage = `Reminder setup complete! If you'd like to access your personal settings, visit your dashboard here ${process.env.DASHBOARD_LINK} or type 'H' for more help.`;
        } else {
          reply = "Please enter a valid night time (e.g., 10 PM)";
        }
        break;
      case "set_time_select_med":
        const medIndex = parseInt(msg) - 1;
        const enabledMeds = user.prescriptions.filter(
          (p) => p.remindersEnabled
        );

        if (isNaN(medIndex)) {
          reply = "Please enter a valid number from the list.";
        } else if (medIndex < 0 || medIndex >= enabledMeds.length) {
          reply = "Invalid selection. Please choose a number from the list.";
        } else {
          const selectedMed = enabledMeds[medIndex];
          user.temp = {
            ...user.temp,
            selectedMedName: selectedMed.name,
          };
          user.flowStep = "set_time_enter_time";
          await user.save();

          // Get current times in user's timezone
          const medTimes = user.medicationSchedule
            .filter((item) => item.prescriptionName === selectedMed.name)
            .map((item) =>
              moment(item.scheduledTime).tz(user.timezone).format("h:mm A")
            );

          const uniqueTimes = [...new Set(medTimes)];
          const currentTimes = uniqueTimes.length
            ? uniqueTimes.join(", ")
            : "not set";

          reply = `You currently take *${selectedMed.name}* at: ${currentTimes}\n\nPlease reply with new time(s) in 12-hour format (e.g., 7am or 8:30pm).\n\nFor multiple times, separate with commas.`;
          handled = true;
        }
        break;
      case "set_time_enter_time":
        if (!user.temp?.selectedMedName) {
          reply = "Something went wrong. Please start over.";
          user.flowStep = "done";
          break;
        }

        const prescription = user.prescriptions.find(
          (p) => p.name === user.temp.selectedMedName
        );

        if (!prescription) {
          reply = "Medication not found. Please try again.";
          user.flowStep = "done";
          break;
        }

        const timeInputs = msg.split(",").map((t) => t.trim());
        const validTimes = [];
        const invalidTimes = [];

        // Parse and validate each time
        for (const timeInput of timeInputs) {
          const time24 = parseTime(timeInput);
          if (time24) {
            validTimes.push(time24);
          } else {
            invalidTimes.push(timeInput);
          }
        }

        if (validTimes.length === 0) {
          reply =
            "No valid times entered. Please use formats like 7am or 8:30pm.";
        } else {
          // Update ONLY the selected prescription's times
          const enabledMeds = user.prescriptions.filter(
            (p) => p.remindersEnabled
          );

          // Create new reminders array with updated times for selected med
          const allReminders = enabledMeds.flatMap((p) => {
            if (p.name === prescription.name) {
              // Use new times for this medication
              return validTimes.map((time) => ({
                time,
                prescriptionName: p.name,
                pillCount: p.tracking.pillCount,
                dosage: p.dosage,
              }));
            } else {
              // Use existing schedule times for other medications
              const medSchedule = user.medicationSchedule.filter(
                (item) => item.prescriptionName === p.name
              );

              // Get distinct times from schedule
              const distinctTimes = [
                ...new Set(
                  medSchedule.map((item) =>
                    moment(item.scheduledTime).tz(user.timezone).format("HH:mm")
                  )
                ),
              ];

              return distinctTimes.map((time) => ({
                time,
                prescriptionName: p.name,
                pillCount: p.tracking.pillCount,
                dosage: p.dosage,
              }));
            }
          });

          const uniqueReminders = Array.from(
            new Map(
              allReminders.map((r) => [`${r.prescriptionName}-${r.time}`, r])
            ).values()
          );

          uniqueReminders.sort(
            (a, b) => moment(a.time, "HH:mm") - moment(b.time, "HH:mm")
          );

          user.reminderTimes = uniqueReminders.map((r) => r.time);

          // Regenerate schedule for ALL medications with updated times
          user.medicationSchedule = generateMedicationSchedule(
            uniqueReminders,
            user.timezone
          );

          user.flowStep = "done";
          user.temp = {};

          // Format times in user's timezone for display
          const formattedTimes = validTimes.map((timeStr) => {
            const [hours, minutes] = timeStr.split(":");
            const hour = parseInt(hours, 10);
            const period = hour >= 12 ? "PM" : "AM";
            const hour12 = hour % 12 || 12;
            return `${hour12}:${minutes} ${period}`;
          });

          reply = `Times updated for ${
            prescription.name
          }! New times: ${formattedTimes.join(", ")}.`;

          if (invalidTimes.length > 0) {
            reply += `\nNote: These times were invalid: ${invalidTimes.join(
              ", "
            )}`;
          }
        }
        break;
      default:
        reply = "Sorry, I didn't understand you. need help, text H.";
    }
  }

  user.tracking.lastInteraction = now;
  await user.save();

  if (reply) {
    await sendMessage(phone, reply);
  }

  if (additionalMessage) {
    await sendMessage(phone, additionalMessage);
  }

  // res.sendStatus(200);
});

// Helper function to send messages
async function sendMessage(phone, message) {
  try {
    await client.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: `+${phone}`, // Use SMS format if needed
    });
    console.log(message);
    console.log(`Message sent to ${phone}: ${message}`);
  } catch (error) {
    console.error("Error sending message:", error);
  }
}

// Validate time input (any time)
function validateTimeAny(input) {
  const timeRegex = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i;
  return timeRegex.test(input);
}

// Validate time input (morning or night)
function validateTime(input, type) {
  if (!validateTimeAny(input)) return false;

  const timeRegex = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i;
  const match = input.match(timeRegex);

  let [_, hour, minute, period] = match;
  hour = parseInt(hour, 10);
  minute = minute ? parseInt(minute, 10) : 0;

  // Convert to 24-hour format
  if (period) {
    period = period.toLowerCase();
    if (period === "pm" && hour < 12) hour += 12;
    if (period === "am" && hour === 12) hour = 0;
  }

  // Validate based on time of day
  if (type === "morning") {
    return hour >= 4 && hour <= 11; // 4 AM to 11 AM
  } else {
    // night
    return (hour >= 20 && hour <= 23) || (hour >= 0 && hour <= 3); // 8 PM to 3 AM
  }
}

// Parse time input into HH:mm format
function parseTime(input) {
  const timeRegex = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i;
  const match = input.match(timeRegex);

  if (!match) return "08:00"; // Default if parsing fails

  let [_, hour, minute, period] = match;
  hour = parseInt(hour, 10);
  minute = minute ? parseInt(minute, 10) : 0;

  // Convert to 24-hour format
  if (period) {
    period = period.toLowerCase();
    if (period === "pm" && hour < 12) hour += 12;
    if (period === "am" && hour === 12) hour = 0;
  }

  // Format as HH:mm
  return `${hour.toString().padStart(2, "0")}:${minute
    .toString()
    .padStart(2, "0")}`;
}

router.get("/getData/:phone", async (req, res) => {
  const phone = req.params.phone;
  try {
    const user = await User.findOne({ phoneNumber: phone }).populate(
      "prescriptions",
      "name dosage timesToTake instructions remindersEnabled initialCount"
    );
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.status(200).json(user);
  } catch (error) {
    console.error("Error fetching user data:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

router.patch("/updatewho/:id", async (req, res) => {
  try {
    const prescriptionId = req.params.id;
    const { forWho, username } = req.body;
    console.log(forWho, username);

    // Validate input
    if (
      !forWho ||
      typeof forWho !== "string" ||
      !username ||
      typeof username !== "string"
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid input values",
      });
    }

    // Find the user who owns this prescription
    const user = await User.findOne({ "prescriptions._id": prescriptionId });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found for this prescription",
      });
    }

    // Update the prescription in the user's array
    const prescriptionIndex = user.prescriptions.findIndex(
      (p) => p._id.toString() === prescriptionId
    );

    if (prescriptionIndex !== -1) {
      user.prescriptions[prescriptionIndex].forWho = forWho;
      user.prescriptions[prescriptionIndex].username = username;
      await user.save();
    }

    res.status(200).json({
      success: true,
      message: "Information updated successfully",
      prescription: user.prescriptions[prescriptionIndex],
    });
  } catch (error) {
    console.log(error);
    console.error("Error updating forWho:", error);

    // Handle specific errors
    if (error.name === "CastError") {
      return res.status(400).json({
        success: false,
        message: "Invalid prescription ID format",
      });
    }

    res.status(500).json({
      success: false,
      message: "Server error while updating information",
      error: error.message,
    });
  }
});

router.patch("/update/:id", async (req, res) => {
  const prescriptionId = req.params.id;
  const updateData = req.body;

  try {
    // 1. Find user by phone number
    const user = await User.findOne({ phoneNumber: updateData.phoneNumber });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // 2. Find the specific prescription by ID
    const prescription = user.prescriptions.id(prescriptionId);
    if (!prescription) {
      return res.status(404).json({
        success: false,
        message: "Prescription not found",
      });
    }

    const oldName = prescription.name;

    // 3. Update fields
    const fields = [
      "name",
      "dosage",
      "timesToTake",
      "instructions",
      "sideEffects",
      "initialCount",
      "remindersEnabled",
    ];

    fields.forEach((field) => {
      if (updateData[field] !== undefined) {
        prescription[field] = updateData[field];
      }
    });

    // 4. Adjust and regenerate reminderTimes with timezone
    if (updateData.reminderTimes) {
      const userTimezone = user.timezone || "Asia/Karachi"; // default if missing

      // Convert to 24-hour format
      const formattedTimes = updateData.reminderTimes.map((time) => {
        const [timePart, modifier] = time.split(" ");
        if (!modifier) return time; // Already 24h
        let [hours, minutes] = timePart.split(":");
        if (modifier === "PM" && hours !== "12") {
          hours = String(parseInt(hours, 10) + 12);
        }
        if (modifier === "AM" && hours === "12") {
          hours = "00";
        }
        return `${hours.padStart(2, "0")}:${minutes}`;
      });

      // Remove old schedule entries for this prescription
      user.medicationSchedule = user.medicationSchedule.filter(
        (item) => item.prescriptionName !== oldName || item.status !== "pending"
      );

      // Generate new schedule for next 7 days in user timezone
      const now = DateTime.now().setZone(userTimezone);
      const today = now.startOf("day");

      for (let day = 0; day < 7; day++) {
        const dayStart = today.plus({ days: day });

        for (const timeStr of formattedTimes) {
          const [hour, minute] = timeStr.split(":").map(Number);

          const scheduled = DateTime.fromObject(
            {
              year: dayStart.year,
              month: dayStart.month,
              day: dayStart.day,
              hour,
              minute,
            },
            { zone: userTimezone }
          );

          if (scheduled > now) {
            user.medicationSchedule.push({
              scheduledTime: scheduled.toJSDate(),
              status: "pending",
              prescriptionName: prescription.name,
            });
          }
        }
      }
    }

    // 5. Update metadata
    user.meta.updatedAt = new Date();

    // 6. Save all changes
    await user.save();

    return res.status(200).json({
      success: true,
      message: "Prescription updated successfully",
      prescription,
    });
  } catch (error) {
    console.error("Error updating prescription:", error);
    return res.status(500).json({
      success: false,
      message: "Server error while updating prescription",
      error: error.message,
    });
  }
});
export default router;

export { sendMessage };
