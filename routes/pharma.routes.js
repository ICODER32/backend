import express from "express";
import Pharmacy from "../models/pharmacy.model.js";
import User from "../models/user.model.js";
import { configDotenv } from "dotenv";
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
    const message = `Welcome to CareTrackRX – your personal pill reminder!
We’ve received your prescriptions:\n${medList}\n\nTo set reminders, reply with the number(s):
1, 2, 3. \n We’ll take care of the rest!`;
    await client.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: `+${phoneNumber}`,
    });
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

export default router;
