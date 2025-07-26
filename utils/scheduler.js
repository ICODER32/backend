import { DateTime } from "luxon";

// Calculate reminder times using wake/sleep and frequency
export const calculateReminderTimes = (
  wakeTime,
  sleepTime,
  instructions,
  frequency,
  name,
  pillCount,
  dosage
) => {
  const times = [];

  const [wakeHour, wakeMin] = wakeTime.split(":").map(Number);
  const [sleepHour, sleepMin] = sleepTime.split(":").map(Number);
  const wakeTotalMin = wakeHour * 60 + wakeMin;
  const sleepTotalMin = sleepHour * 60 + sleepMin;
  const totalAwakeMinutes = sleepTotalMin - wakeTotalMin;

  const formatTime = (hour, minute) =>
    `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;

  if (frequency === 1) {
    const reminderMin = wakeTotalMin + 60;
    const hour = Math.floor(reminderMin / 60);
    const min = reminderMin % 60;
    times.push({
      prescriptionName: name,
      time: formatTime(hour, min),
      dosage,
      pillCount,
    });
    return times;
  }

  if (frequency === 2) {
    const reminder1Min = wakeTotalMin + 60;
    const reminder2Min = sleepTotalMin - 60;

    [reminder1Min, reminder2Min].forEach((m) => {
      const hour = Math.floor(m / 60);
      const min = m % 60;
      times.push({
        prescriptionName: name,
        time: formatTime(hour, min),
        dosage,
        pillCount,
      });
    });
    return times;
  }

  // More than 2: Spread evenly
  const interval = totalAwakeMinutes / (frequency - 1);
  for (let i = 0; i < frequency; i++) {
    const reminderMin = wakeTotalMin + i * interval;
    const hour = Math.floor(reminderMin / 60);
    const min = Math.round(reminderMin % 60);
    times.push({
      prescriptionName: name,
      time: formatTime(hour, min),
      dosage,
      pillCount,
    });
  }

  return times;
};

// Generate full medication schedule for all reminders
export const generateMedicationSchedule = (
  reminders,
  timezone,
  startDate = new Date()
  // california time zone
) => {
  const schedule = [];
  const now = DateTime.now().setZone(timezone);
  const groupedByPrescription = reminders.reduce((acc, r) => {
    if (!acc[r.prescriptionName]) acc[r.prescriptionName] = [];
    acc[r.prescriptionName].push(r);
    return acc;
  }, {});

  Object.entries(groupedByPrescription).forEach(
    ([prescriptionName, reminderArray]) => {
      const dailyDosage = reminderArray.reduce((sum, r) => sum + r.dosage, 0);
      const totalPills = reminderArray[0].pillCount;
      const totalDays = Math.floor(totalPills / dailyDosage);

      // Check if we need to skip today
      let skipFirstDay = false;
      for (const reminder of reminderArray) {
        const [hour, minute] = reminder.time.split(":").map(Number);
        const doseTime = DateTime.fromJSDate(startDate)
          .setZone(timezone)
          .set({ hour, minute, second: 0, millisecond: 0 });

        if (doseTime < now) {
          skipFirstDay = true;
          break;
        }
      }

      let adjustedStart = DateTime.fromJSDate(startDate).setZone(timezone);
      if (skipFirstDay) {
        adjustedStart = adjustedStart.plus({ days: 1 });
      }

      for (let day = 0; day < totalDays; day++) {
        const currentDay = adjustedStart.plus({ days: day });

        reminderArray.forEach((r) => {
          const [hour, minute] = r.time.split(":").map(Number);
          const scheduledTime = currentDay.set({ hour, minute, second: 0 });

          schedule.push({
            prescriptionName,
            scheduledTime: scheduledTime.toISO(), // Store in ISO format with timezone
            localTime: scheduledTime.toLocaleString(DateTime.DATETIME_MED), // Human-readable
            dosage: r.dosage,
            status: "pending",
          });
        });
      }
    }
  );

  return schedule;
};
