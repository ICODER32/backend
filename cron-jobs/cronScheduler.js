import cron from "node-cron";
import moment from "moment";
import User from "../models/user.model.js";
import twilio from "twilio";
import dotenv from "dotenv";
dotenv.config();

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

export function startReminderCron() {
  cron.schedule("*/1 * * * *", async () => {
    const now = moment().utcOffset(new Date().getTimezoneOffset() * -1);
    console.log(
      `⏰ Starting reminder check at ${now.format("YYYY-MM-DD HH:mm:ss")}`
    );

    try {
      const activeUsers = await User.find({
        status: "active",
        notificationsEnabled: true,
      });

      console.log(`👥 Found ${activeUsers.length} active users`);

      for (const user of activeUsers) {
        try {
          const dueReminders = user.medicationSchedule.filter((schedule) => {
            if (schedule.status !== "pending") return false;
            const scheduledTime = moment(schedule.scheduledTime);
            const timeDiff = Math.abs(scheduledTime.diff(now, "minutes"));
            return timeDiff <= 10;
          });

          if (dueReminders.length === 0) continue;

          // Group by prescription name with times
          const medicationsMap = {};
          dueReminders.forEach((reminder) => {
            const timeStr = moment(reminder.scheduledTime).format("h:mm a");
            if (!medicationsMap[reminder.prescriptionName]) {
              medicationsMap[reminder.prescriptionName] = new Set();
            }
            medicationsMap[reminder.prescriptionName].add(timeStr);
          });

          // Check if we recently sent a reminder
          const lastReminder = user.tracking.lastReminderSent
            ? moment(user.tracking.lastReminderSent)
            : moment(0);
          const minutesSinceLast = now.diff(lastReminder, "minutes");

          if (minutesSinceLast < 15) {
            console.log(
              `⏭ Skipping ${user.phoneNumber} (recent reminder sent)`
            );
            continue;
          }

          // Create formatted medication list
          let message = "💊 It’s time to take your medications:\n";
          for (const [medication, times] of Object.entries(medicationsMap)) {
            const sortedTimes = [...times].sort((a, b) =>
              moment(a, "h:mm a").diff(moment(b, "h:mm a"))
            );
            message += `\n• ${medication}: ${sortedTimes.join(", ")}`;
          }
          message += `Please reply:
               \n D – if you have taken them
               \n S – if you need to skip this dose
               \n Thank you for using CareTrackRX.`;
          console.log(message);
          // Send message
          await client.messages.create({
            body: message,
            from: process.env.TWILIO_PHONE_NUMBER,
            to: `+${user.phoneNumber}`,
          });

          console.log(
            `✅ Reminder sent to ${user.phoneNumber} for ${dueReminders.length} medications`
          );

          // Update user tracking and schedule
          user.tracking.lastReminderSent = now.toDate();

          // Store unique medication names for follow-up
          const uniqueMeds = Object.keys(medicationsMap);

          user.notificationHistory.push({
            sentAt: now.toDate(),
            message: `Sent reminder for ${uniqueMeds.length} medications`,
            status: "pending",
            medications: uniqueMeds,
            resends: 0,
          });

          await user.save();
        } catch (userError) {
          console.error(`❌ Error processing ${user.phoneNumber}:`, userError);
          user.notificationHistory.push({
            sentAt: new Date(),
            message: "Failed to send reminder",
            status: "failed",
            error: userError.message,
          });
          await user.save();
        }
      }

      console.log(`🏁 Reminder cycle completed at ${now.format("HH:mm:ss")}`);
    } catch (error) {
      console.error("🚨 Critical error in reminder cycle:", error);
    }
  });
}

// Modified to only handle skipped medications
async function notifyCaregivers(user, reminders) {
  if (!user.caregivers || user.caregivers.length === 0) return;

  // Group reminders by prescription
  const prescriptionsMap = {};
  reminders.forEach((reminder) => {
    const prescription = user.prescriptions.find(
      (p) => p.name === reminder.prescriptionName
    );
    if (prescription) {
      if (!prescriptionsMap[prescription.username]) {
        prescriptionsMap[prescription.username] = [];
      }
      prescriptionsMap[prescription.username].push({
        name: prescription.name,
      });
    }
  });

  // Notify each caregiver
  for (const caregiver of user.caregivers) {
    if (!caregiver.notificationsEnabled) continue;

    let medicationsToNotify = [];

    // Find medications this caregiver should be notified about
    caregiver.forPersons.forEach((person) => {
      if (prescriptionsMap[person]) {
        medicationsToNotify = [
          ...medicationsToNotify,
          ...prescriptionsMap[person],
        ];
      }
    });

    if (medicationsToNotify.length === 0) continue;

    const message =
      `⚠️ User ${user.phoneNumber} has skipped:\n` +
      medicationsToNotify.map((m) => `• ${m.name}`).join("\n");

    try {
      await client.messages.create({
        body: message,
        from: process.env.TWILIO_PHONE_NUMBER, // Uncomment if using SMS
        to: `+${caregiver.phoneNumber}`, // Use SMS format if needed
      });
      console.log(message);
      console.log(`   👩‍⚕️ Caregiver notified: ${caregiver.phoneNumber}`);
    } catch (error) {
      console.error(
        `   ❌ Failed to notify caregiver ${caregiver.phoneNumber}:`,
        error
      );
    }
  }
}

export function startReminderFollowupCron() {
  cron.schedule("*/1 * * * *", async () => {
    const now = moment().utcOffset(new Date().getTimezoneOffset() * -1);
    console.log(
      `🔁 Checking follow-up reminders at ${now.format("YYYY-MM-DD HH:mm:ss")}`
    );

    try {
      const users = await User.find({
        status: "active",
        notificationsEnabled: true,
        "notificationHistory.status": "pending",
      });

      for (const user of users) {
        const pendingNotifications = user.notificationHistory.filter(
          (n) => n.status === "pending"
        );

        for (const notification of pendingNotifications) {
          const sentAt = moment(notification.sentAt);
          const minutesPassed = now.diff(sentAt, "minutes");

          if (notification.resends === 0 && minutesPassed >= 2) {
            await sendFollowupReminder(user, notification, 1);
          } else if (notification.resends === 1 && minutesPassed >= 4) {
            await sendFollowupReminder(user, notification, 2);
          } else if (notification.resends === 2 && minutesPassed >= 5) {
            notification.status = "skipped";
            console.log(
              `🚫 Marked reminder as skipped for ${user.phoneNumber}`
            );
            const skippedReminders = notification.medications.map((name) => ({
              prescriptionName: name,
            }));
            await notifyCaregivers(user, skippedReminders);
          }
        }

        await user.save();
      }
    } catch (err) {
      console.error("🚨 Error in follow-up cron:", err);
    }
  });
}
async function sendFollowupReminder(user, notification, resendCount) {
  try {
    const medList = notification.medications.join(", ");
    const message = `It's time to take your medications: ${medList}.\n\nPlease reply:\nD – if you have taken them\nS – if you need to skip this dose\n\nThank you for using CareTrackRX.`;

    await client.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: `+${user.phoneNumber}`,
    });

    console.log(
      `📨 Follow-up sent to ${user.phoneNumber} (resend ${resendCount})`
    );

    notification.resends = resendCount;
  } catch (error) {
    console.error(`❌ Failed to resend to ${user.phoneNumber}:`, error);
    notification.status = "failed";
    notification.error = error.message;
  }
}
