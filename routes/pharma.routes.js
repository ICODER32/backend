import express from "express";
import Pharmacy from "../models/pharmacy.model.js";
import User from "../models/user.model.js";
import { configDotenv } from "dotenv";
import moment from "moment-timezone";
import { sendMessage } from "./user.routes.js";
import {
  calculateReminderTimes,
  generateMedicationSchedule,
} from "../utils/scheduler.js";
configDotenv();
const router = express.Router();
import twilio from "twilio";

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

router.post("/addPharmacy", async (req, res) => {
  const { firstName, lastName, phoneNumber, prescriptions, description } =
    req.body;

  try {
    // Validate prescriptions array
    if (!Array.isArray(prescriptions)) {
      return res
        .status(400)
        .json({ message: "Prescriptions must be an array" });
    }

    // Create new pharmacy
    const newPharmacy = new Pharmacy({
      firstName,
      lastName,
      phoneNumber,
      prescriptions,
      description,
    });
    await newPharmacy.save();

    // Create associated user with prescriptions
    const user = new User({
      phoneNumber,
      prescriptions: prescriptions.map((p) => ({
        name: p.name,
        timesToTake: p.timesToTake,
        dosage: p.dosage,
        instructions: p.instructions || "",
        initialCount: p.initialCount,
        remindersEnabled: false,
        sideEffects: p.sideEffects || "",
        tracking: {
          pillCount: p.initialCount,
          dailyConsumption: 0,
        },
      })),
      status: "inactive",
      flowStep: "ask_reminders",
    });

    await user.save();

    // Build medication list for message
    const medList = prescriptions
      .map((p, i) => `${i + 1}. ${p.name}`)
      .join("\n");

    // Send initial message
    const message = `Welcome to CareTrackRX!
We've received your prescriptions:
${medList}
To set up reminders, please reply with the numbers) of the prescriptions you'd like to track.
(Example: 1, 2, or 1)
Reply STOP to unsubscribe at any time.
`;
    try {
      const message1 = await client.messages.create({
        body: message,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: `+${phoneNumber}`,
      });
      console.log(message1);
    } catch (err) {
      console.log(err);
    }

    console.log(message);
    console.log(
      `Welcome message sent to +${phoneNumber} with medications:\n${medList}`
    );

    res.status(201).json({
      message: "Pharmacy added successfully",
      pharmacy: newPharmacy,
    });
  } catch (error) {
    console.error("Error adding pharmacy:", error);
    res.status(500).json({ message: "Error adding pharmacy", error });
  }
});

router.get("/getPharmacies", async (req, res) => {
  try {
    const pharmacies = await Pharmacy.find();
    res.status(200).json(pharmacies);
  } catch (error) {
    res.status(500).json({ message: "Error fetching pharmacies", error });
  }
});

router.post("/addPrescription", async (req, res) => {
  const { phoneNumber, prescription } = req.body;

  try {
    // Validate input
    if (!phoneNumber || !prescription) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    // Find user
    const user = await User.findOne({ phoneNumber });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Create new prescription object
    const newPrescription = {
      name: prescription.name,
      timesToTake: prescription.timesToTake,
      dosage: prescription.dosage,
      instructions: prescription.instructions || "",
      initialCount: prescription.initialCount,
      remindersEnabled: true, // Automatically enable reminders
      sideEffects: prescription.sideEffects || "",
      tracking: {
        pillCount: prescription.initialCount,
        dailyConsumption: 0,
        skippedCount: 0,
      },
    };

    // Add to user's prescriptions
    user.prescriptions.push(newPrescription);
    const addedPrescription = user.prescriptions[user.prescriptions.length - 1];

    // Generate schedule for new prescription only
    const newReminders = calculateReminderTimes(
      user.wakeTime,
      user.sleepTime,
      newPrescription.instructions,
      newPrescription.timesToTake,
      newPrescription.name,
      newPrescription.tracking.pillCount,
      newPrescription.dosage,
      addedPrescription._id // Use the generated ID
    ).map((r) => ({
      time: r.time,
      prescriptionName: r.prescriptionName,
      prescriptionId: addedPrescription._id,
      pillCount: r.pillCount,
      dosage: r.dosage,
    }));

    // Generate schedule items
    const newSchedule = generateMedicationSchedule(newReminders, user.timezone);

    // Add to existing schedule
    user.medicationSchedule.push(...newSchedule);

    // Update user
    await user.save();

    // Send confirmation message
    const times = newReminders
      .map((r) => moment(r.time, "HH:mm").format("h:mm A"))
      .join(", ");

    const message =
      `New prescription added: ${prescription.name}\n` +
      `You'll get reminders at: ${times}\n` +
      `Reply H for help or to change reminder times`;

    await sendMessage(phoneNumber, message);

    res.status(200).json({
      success: true,
      message: "Prescription added successfully",
      prescription: addedPrescription,
    });
  } catch (error) {
    console.error("Error adding prescription:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

export default router;
