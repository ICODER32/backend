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
  const normalizedInstructions = instructions.toLowerCase();

  // Parse times to minutes since midnight
  const [wakeHour, wakeMin] = wakeTime.split(":").map(Number);
  const [sleepHour, sleepMin] = sleepTime.split(":").map(Number);
  const wakeTotalMin = wakeHour * 60 + wakeMin;
  const sleepTotalMin = sleepHour * 60 + sleepMin;

  const formatTime = (totalMinutes) => {
    const hour = Math.floor(totalMinutes / 60) % 24;
    const min = Math.floor(totalMinutes % 60);
    return `${hour.toString().padStart(2, "0")}:${min
      .toString()
      .padStart(2, "0")}`;
  };

  // Helper to check for specific instruction keywords
  const isBeforeBed =
    normalizedInstructions.includes("bed") ||
    normalizedInstructions.includes("sleep");
  const isWithBreakfast =
    normalizedInstructions.includes("breakfast") ||
    normalizedInstructions.includes("morning");
  const isAfterMeal =
    normalizedInstructions.includes("after meal") ||
    normalizedInstructions.includes("after food");
  const isBeforeMeal =
    normalizedInstructions.includes("before meal") ||
    normalizedInstructions.includes("before food");

  // Handle single dose medications
  if (frequency === 1) {
    let reminderMin;

    if (isBeforeBed) {
      reminderMin = sleepTotalMin - 60; // 1 hour before bed
    } else if (isWithBreakfast) {
      reminderMin = wakeTotalMin + 60; // 1 hour after wake
    } else if (isAfterMeal || isBeforeMeal) {
      // Default to lunch time (midpoint between wake and sleep)
      reminderMin =
        wakeTotalMin + Math.floor((sleepTotalMin - wakeTotalMin) / 2);
    } else {
      // Default: 1 hour after wake time
      reminderMin = wakeTotalMin + 60;
    }

    times.push({
      prescriptionName: name,
      time: formatTime(reminderMin),
      dosage,
      pillCount,
    });
    return times;
  }

  // Handle two doses
  if (frequency === 2) {
    let firstDose, secondDose;

    if (isBeforeBed || isWithBreakfast) {
      // New behavior: breakfast + bedtime (skip noon)
      firstDose = wakeTotalMin + 60; // Breakfast
      secondDose = sleepTotalMin - 60; // Bedtime
    } else if (normalizedInstructions.includes("dinner")) {
      // Existing dinner behavior
      firstDose = wakeTotalMin + 60;
      secondDose = sleepTotalMin - 60;
    } else {
      // Default behavior
      firstDose = wakeTotalMin + 60;
      secondDose = sleepTotalMin - 60;
    }

    // Add both doses to schedule
    times.push({
      prescriptionName: name,
      time: formatTime(firstDose),
      dosage,
      pillCount,
    });
    times.push({
      prescriptionName: name,
      time: formatTime(secondDose),
      dosage,
      pillCount,
    });
    return times;
  }

  // Handle three or more doses
  const buffer = 60; // 1-hour buffer before/after sleep
  let startTime = wakeTotalMin;
  let endTime = sleepTotalMin;

  // Adjust boundaries based on instructions
  if (isWithBreakfast) startTime += 60;
  if (isBeforeBed) endTime -= 60;

  // Ensure valid time range
  if (endTime <= startTime) endTime = startTime + 60 * frequency;

  const timeRange = endTime - startTime;
  const interval = timeRange / (frequency - 1);

  // Generate dose times
  for (let i = 0; i < frequency; i++) {
    let doseTime = startTime + i * interval;

    // Adjust last dose if "before bed" specified
    if (isBeforeBed && i === frequency - 1) {
      doseTime = sleepTotalMin - 60;
    }
    // Adjust first dose if "with breakfast" specified
    else if (isWithBreakfast && i === 0) {
      doseTime = wakeTotalMin + 60;
    }

    times.push({
      prescriptionName: name,
      time: formatTime(doseTime),
      dosage,
      pillCount,
    });
  }

  return times;
};

// Generate full medication schedule for all reminders
const formatTime = (totalMinutes) => {
  const hour = Math.floor(totalMinutes / 60) % 24;
  const min = Math.floor(totalMinutes % 60);
  return `${hour.toString().padStart(2, "0")}:${min
    .toString()
    .padStart(2, "0")}`;
};

// Generate full medication schedule
export const generateMedicationSchedule = (
  reminders,
  timezone,
  startDate = new Date()
) => {
  const now = DateTime.now().setZone(timezone);
  const schedule = [];

  // Group reminders by prescription ID instead of name
  const groupedByPrescription = reminders.reduce((acc, r) => {
    const key = r.prescriptionId || r.prescriptionName;
    if (!acc[key]) acc[key] = [];
    acc[key].push(r);
    return acc;
  }, {});

  Object.entries(groupedByPrescription).forEach(
    ([prescriptionKey, reminderArray]) => {
      const adjustedStart = DateTime.fromJSDate(startDate).setZone(timezone);
      const today = adjustedStart.startOf("day");

      // Only generate schedule for next 7 days
      for (let day = 0; day < 7; day++) {
        const currentDay = today.plus({ days: day });

        reminderArray.forEach((r) => {
          const [hour, minute] = r.time.split(":").map(Number);
          const scheduledTime = currentDay.set({
            hour,
            minute,
            second: 0,
            millisecond: 0,
          });

          // Only create future schedule items
          if (scheduledTime > now) {
            schedule.push({
              prescriptionName: r.prescriptionName,
              prescriptionId: r.prescriptionId,
              scheduledTime: scheduledTime.toISO(),
              localTime: scheduledTime.toLocaleString(DateTime.DATETIME_MED),
              dosage: r.dosage,
              status: "pending",
              reminderSent: false,
            });
          }
        });
      }
    }
  );

  return schedule;
};
