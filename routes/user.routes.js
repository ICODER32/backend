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
import momentimzone from "moment-timezone";

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

  // Initialize temp if it doesn't exist
  if (!user.temp) {
    user.temp = {};
  }
  // UPDATE TIME ZONE
  if (req.body.FromState == "CA") {
    user.timezone = "America/Los_Angeles";
  } else if (req.body.FromState == "NY") {
    user.timezone = "America/New_York";
  } else if (req.body.FromState == "TX") {
    user.timezone = "America/Chicago";
  } else if (req.body.FromState == "FL") {
    user.timezone = "America/New_York";
  }
  // Michigan
  else if (req.body.FromState == "MI") {
    user.timezone = "America/New_York";
  } else if (req.body.FromState == "WA") {
    user.timezone = "America/Los_Angeles";
  } else if (req.body.FromState == "OH") {
    user.timezone = "America/New_York";
  } else if (req.body.FromState == "PA") {
    user.timezone = "America/New_York";
  } else if (req.body.FromState == "IL") {
    user.timezone = "America/Chicago";
  } else if (req.body.FromState == "NJ") {
    user.timezone = "America/New_York";
  } else if (req.body.FromState == "GA") {
    user.timezone = "America/New_York";
  } else {
    // islamabad pakistan
    user.timezone = "Asia/Karachi";
  }

  await user.save(); // Save timezone change

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

  if (!handled && lowerMsg === "d") {
    // Find the most recent pending notification
    const pendingNotifications = user.notificationHistory
      .filter((n) => n.status === "pending")
      .sort((a, b) => b.sentAt - a.sentAt); // Sort descending by time

    if (pendingNotifications.length === 0) {
      // Check for the most recent missed notification
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
      const medications = mostRecentNotification.medications;

      // Update notification status
      mostRecentNotification.status = "taken";

      // Find and update corresponding schedule items
      medications.forEach((medName) => {
        const scheduleItem = user.medicationSchedule
          .filter(
            (item) =>
              item.prescriptionName === medName && item.status === "pending"
          )
          .sort((a, b) => a.scheduledTime - b.scheduledTime)[0]; // Get earliest

        if (scheduleItem) {
          scheduleItem.status = "taken";
          scheduleItem.takenAt = now;

          // Update pill count in prescription
          const prescription = user.prescriptions.find(
            (p) => p.name === medName
          );

          if (prescription) {
            prescription.tracking.pillCount -= prescription.dosage;
            prescription.tracking.dailyConsumption += prescription.dosage;
            if (prescription.tracking.pillCount < 0) {
              prescription.tracking.pillCount = 0;
            }
          }
        }
      });

      reply = `Confirmed! You've taken your medications: ${medications.join(
        ", "
      )}.`;
      handled = true;
    }
  }

  if (!handled && lowerMsg === "s") {
    // Find the most recent pending notification
    const pendingNotifications = user.notificationHistory
      .filter((n) => n.status === "pending")
      .sort((a, b) => b.sentAt - a.sentAt); // Sort descending by time
    if (pendingNotifications.length === 0) {
      reply = "You don't have any pending medications to skip.";
      handled = true;
    } else {
      const mostRecentNotification = pendingNotifications[0];
      const medications = mostRecentNotification.medications;
      // Update notification status
      mostRecentNotification.status = "skipped";
      // Find and update corresponding schedule items
      medications.forEach((medName) => {
        // Find the earliest pending schedule item for this medication
        const scheduleItem = user.medicationSchedule
          .filter(
            (item) =>
              item.prescriptionName === medName && item.status === "pending"
          )
          .sort((a, b) => a.scheduledTime - b.scheduledTime)[0]; // Get earliest
        if (scheduleItem) {
          scheduleItem.status = "skipped";
          scheduleItem.takenAt = now;
        }
      });
      // update the tracking skipped count
      user.prescriptions.forEach((p) => {
        if (medications.includes(p.name)) {
          p.tracking.skippedCount += 1;
        }
      });
      reply = `Skipped! You chose to skip your medications: ${medications.join(
        ", "
      )}.`;
      handled = true;
    }
  }

  if (!handled && lowerMsg === "stop") {
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
      const timezone = user.timezone || "Asia/Karachi"; // fallback if timezone not set

      const medList = enabledMeds
        .map((p, i) => {
          // Get scheduled times for this medication
          const medTimes = user.medicationSchedule
            .filter((item) => item.prescriptionName === p.name)
            .map((item) =>
              momentimzone(item.scheduledTime).tz(timezone).format("h:mm A")
            );

          const uniqueTimes = [...new Set(medTimes)];

          return `${i + 1}. ${p.name} (Current times: ${
            uniqueTimes.length > 0 ? uniqueTimes.join(", ") : "not set"
          })`;
        })
        .join("\n");

      reply =
        `Which pill would you like to set a custom time for?\n` +
        `Reply with a number:\n${medList}\n` +
        `(Type the number of the pill you want to change.)`;

      user.flowStep = "set_time_select_med";
      user.temp = {}; // Clear any previous temp
      await user.save(); // Save user with flow step
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

          // SOLUTION: Reassign the entire temp object
          user.temp = {
            ...user.temp, // Preserve existing temp properties
            selectedMedName: selectedMed.name, // Add new property
          };

          user.flowStep = "set_time_enter_time";
          await user.save();
          user.flowStep = "set_time_enter_time";
          user = await user.save(); // Save immediately after setting flowStep
          console.log(user.temp);

          // Get current times for this medication from schedule
          const medTimes = user.medicationSchedule
            .filter((item) => item.prescriptionName === selectedMed.name)
            .map((item) => moment(item.scheduledTime).format("h:mm A"));

          // Get unique times and convert each time to 12 hour format
          const uniqueTimes = [...new Set(medTimes)];
          const currentTimes = uniqueTimes.length
            ? uniqueTimes.join(", ")
            : "not set";
          // Prepare reply with current times
          const timeFormat = uniqueTimes.map((time) =>
            moment(time, "HH:mm").format("h:mm A")
          );

          // convert each time to 12 hour format
          reply = `You have ${selectedMed.name} at ${timeFormat}. Reply with new time(s) in 12-hour format (e.g., 7am or 8:30pm). For multiple times, separate with commas.`;
        }
        break;

      case "set_time_enter_time":
        // Check if we have the selected medication name
        console.log("selected meds", user.temp, user.temp.selectedMedName);
        if (!user.temp || !user.temp.selectedMedName) {
          reply = "Something went wrong. Please start over.";
          user.flowStep = "done";
          break;
        }

        // Find medication by name
        const prescription = user.prescriptions.find(
          (p) => p.name === user.temp.selectedMedName
        );

        if (!prescription) {
          reply = "Medication not found. Please try again.";
          user.flowStep = "done";
          break;
        }

        // Process time input
        const timeInputs = msg.split(",").map((t) => t.trim());
        const validTimes = [];
        const invalidTimes = [];

        const today = moment().format("YYYY-MM-DD");

        for (const timeInput of timeInputs) {
          if (validateTimeAny(timeInput)) {
            // Parse into moment object using timezone
            const parsed = moment.tz(
              `${today} ${timeInput}`,
              "YYYY-MM-DD hh:mma",
              user.timezone || "Asia/Karachi"
            );

            if (parsed.isValid()) {
              validTimes.push(parsed.format("HH:mm")); // store just the time
            } else {
              invalidTimes.push(timeInput);
            }
          } else {
            invalidTimes.push(timeInput);
          }
        }

        if (validTimes.length === 0) {
          reply =
            "No valid times entered. Please use formats like 7am or 8:30pm.";
        } else {
          // Recalculate schedule with new times
          const allEnabledMeds = user.prescriptions.filter(
            (p) => p.remindersEnabled
          );
          const allReminders = allEnabledMeds.flatMap((p) => {
            if (p.name === prescription.name) {
              // Use new times for this medication
              return validTimes.map((time) => ({
                time,
                prescriptionName: p.name,
                pillCount: p.tracking.pillCount,
                dosage: p.dosage,
              }));
            } else {
              // Use existing times for other medications
              const medTimes = user.medicationSchedule
                .filter((item) => item.prescriptionName === p.name)
                .map((item) => moment(item.scheduledTime).format("HH:mm"));

              const uniqueTimes = [...new Set(medTimes)];

              return uniqueTimes.map((time) => ({
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
          user.medicationSchedule = generateMedicationSchedule(
            uniqueReminders,
            user.timezone
          );
          user.flowStep = "done";
          user.temp = {}; // Clear temp data

          reply = `Times updated for ${
            prescription.name
          }! New times: ${validTimes.join(", ")}.`;

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
