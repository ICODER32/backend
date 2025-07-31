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

    if (isBeforeBed) {
      // Second dose before bed, first dose at midpoint
      secondDose = sleepTotalMin - 60;
      firstDose = wakeTotalMin + Math.floor((secondDose - wakeTotalMin) / 2);
    } else if (isWithBreakfast) {
      // First dose with breakfast, second dose at midpoint
      firstDose = wakeTotalMin + 60;
      secondDose = firstDose + Math.floor((sleepTotalMin - firstDose) / 2);
    } else if (normalizedInstructions.includes("dinner")) {
      // First with breakfast, second with dinner
      firstDose = wakeTotalMin + 60;
      secondDose = sleepTotalMin - 60;
    } else {
      // Default: breakfast and dinner times
      firstDose = wakeTotalMin + 60;
      secondDose = sleepTotalMin - 60;
    }

    [firstDose, secondDose].forEach((dose) => {
      times.push({
        prescriptionName: name,
        time: formatTime(dose),
        dosage,
        pillCount,
      });
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

  // Group reminders by prescription name
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

      const adjustedStart = DateTime.fromJSDate(startDate).setZone(timezone);
      const today = adjustedStart.startOf("day");

      for (let day = 0; day < totalDays; day++) {
        const currentDay = today.plus({ days: day });

        reminderArray.forEach((r) => {
          const [hour, minute] = r.time.split(":").map(Number);
          const scheduledTime = currentDay.set({
            hour,
            minute,
            second: 0,
            millisecond: 0,
          });

          // Check if this schedule item already exists
          const existingItem = schedule.find(
            (item) =>
              item.prescriptionName === prescriptionName &&
              DateTime.fromISO(item.scheduledTime).toMillis() ===
                scheduledTime.toMillis()
          );

          if (existingItem) {
            // Preserve existing status
            schedule.push({
              ...existingItem,
              scheduledTime: scheduledTime.toISO(),
            });
          } else {
            // Create new item with pending status
            schedule.push({
              prescriptionName,
              scheduledTime: scheduledTime.toISO(),
              localTime: scheduledTime.toLocaleString(DateTime.DATETIME_MED),
              dosage: r.dosage,
              status: "pending",
            });
          }
        });
      }
    }
  );

  return schedule;
};
