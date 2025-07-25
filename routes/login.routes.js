import express from "express";
import User from "../models/user.model.js";
import twilio from "twilio";
const router = express.Router();
import { configDotenv } from "dotenv";
import jwt from "jsonwebtoken";
configDotenv();
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

router.post("/get-otp", async (req, res) => {
  const { phoneNumber } = req.body;

  if (!phoneNumber) {
    return res.status(400).json({ message: "Phone number is required" });
  }

  try {
    // Send OTP via WhatsApp
    const otp = Math.floor(1000 + Math.random() * 9000); // Generate a random 4-digit OTP
    await client.messages.create({
      body: `Your OTP for CareTrack RX is: ${otp}`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: `+${phoneNumber}`,
    });

    // Store OTP in session or database (not implemented here)

    // req.session.otp = otp; // Example using session

    // Alternatively, you can save it in the database
    const user = await User.findOneAndUpdate(
      { phoneNumber },
      { otp }, // Save OTP in user document
      { timezone: req.body.timezone }, // Save timezone
      { new: true, upsert: true } // Create user if not exists
    );
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    await user.save();

    res.status(200).json({ message: "OTP sent successfully" });
  } catch (error) {
    console.error("Error sending OTP:", error);
    res.status(500).json({ message: "Failed to send OTP", error });
  }
});

router.post("/verify-otp", async (req, res) => {
  const { phoneNumber, otp } = req.body;

  if (!phoneNumber || !otp) {
    return res
      .status(400)
      .json({ message: "Phone number and OTP are required" });
  }

  try {
    // Find user by phone number
    const user = await User.findOne({ phoneNumber });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Check if OTP matches
    if (user.otp !== otp) {
      return res.status(400).json({ message: "Invalid OTP" });
    }

    // Clear OTP after successful verification
    user.otp = null;
    user.isVerified = true; // Mark user as verified
    await user.save();

    // Generate JWT token
    const token = jwt.sign(
      { userId: user._id, phoneNumber: user.phoneNumber },
      process.env.JWT_SECRET || "default",
      // valid for 2 days
      { expiresIn: "2d" }
    );

    res.cookie("token", token, {
      httpOnly: true, // can't be accessed by JS
      secure: process.env.NODE_ENV === "production", // only over HTTPS in production
      sameSite: "strict", // protects against CSRF
      maxAge: 2 * 24 * 60 * 60 * 1000, // 2 days
    });

    res.status(200).json({ message: "OTP verified successfully", token });
  } catch (error) {
    console.error("Error verifying OTP:", error);
    res.status(500).json({ message: "Failed to verify OTP", error });
  }
});

router.get("/me", async (req, res) => {
  const token = req.cookies.token;
  console.log(token);
  if (!token) return res.status(401).json({ message: "Unauthorized" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId);
    if (!user) throw new Error("User not found");
    res.status(200).json({ phoneNumber: user.phoneNumber });
  } catch (err) {
    res.status(401).json({ message: "Invalid token" });
  }
});

export default router;
