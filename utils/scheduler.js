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

  const formatTime = (hour, minute) =>
    `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;

  const [wakeHour, wakeMin] = wakeTime.split(":").map(Number);
  const [sleepHour, sleepMin] = sleepTime.split(":").map(Number);
  const wakeTotalMin = wakeHour * 60 + wakeMin;
  const sleepTotalMin = sleepHour * 60 + sleepMin;
  const totalAwakeMinutes = sleepTotalMin - wakeTotalMin;

  if (frequency === 1) {
    const reminderMin = wakeTotalMin + 60; // 1 hour after wake time
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
    // First: 1hr after wake, Second: 1hr before sleep
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

  // Spread evenly if more than 2
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
  startDate = new Date()
) => {
  const schedule = [];
  const now = new Date(); // Capture current time once

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

      // Determine if we need to skip the first day for this prescription
      let skipFirstDay = false;
      for (const reminder of reminderArray) {
        const [hour, minute] = reminder.time.split(":").map(Number);
        const doseTime = new Date(startDate);
        doseTime.setHours(hour, minute, 0, 0);
        if (doseTime < now) {
          skipFirstDay = true;
          break; // Skip entire day if any reminder has passed
        }
      }

      // Adjust start date: skip to next day if needed
      const adjustedStartDate = new Date(startDate);
      if (skipFirstDay) {
        adjustedStartDate.setDate(adjustedStartDate.getDate() + 1);
      }

      // Generate schedule for the calculated days
      for (let day = 0; day < totalDays; day++) {
        reminderArray.forEach((r) => {
          const [hour, minute] = r.time.split(":").map(Number);
          const scheduledDateTime = new Date(adjustedStartDate);
          scheduledDateTime.setDate(adjustedStartDate.getDate() + day);
          scheduledDateTime.setHours(hour, minute, 0, 0);

          schedule.push({
            prescriptionName,
            scheduledTime: scheduledDateTime,
            dosage: r.dosage,
            status: "pending",
          });
        });
      }
    }
  );

  return schedule;
};
