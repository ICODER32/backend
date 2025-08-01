import express from "express";
import User from "../models/user.model.js";
import { sendMessage } from "./user.routes.js";

const router = express.Router();

// Get all caregivers
router.get("/:phoneNumber", async (req, res) => {
  const { phoneNumber } = req.params;

  try {
    const user = await User.findOne({ phoneNumber }).select("caregivers");
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }
    console.log(user);
    res.status(200).json({ success: true, caregivers: user.caregivers });
  } catch (error) {
    console.error("Error fetching caregivers:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching caregivers",
      error: error.message,
    });
  }
});

// Add a new caregiver
router.post("/", async (req, res) => {
  const { phoneNumber, caregiver } = req.body;
  console.log(req.body);

  try {
    const user = await User.findOne({ phoneNumber });
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    // Check if caregiver already exists
    const exists = user.caregivers.some(
      (c) => c?.phoneNumber === caregiver?.phoneNumber
    );

    if (exists) {
      return res.status(400).json({
        success: false,
        message: "Caregiver with this phone number already exists",
      });
    }

    // Add new caregiver
    user.caregivers.push(caregiver);
    await user.save();
    const message = `You have been added as a caregiver for ${user.phoneNumber}`;
    await sendMessage(caregiver.phoneNumber, message);

    res.status(201).json({
      success: true,
      message: "Caregiver added successfully",
      caregiver,
    });
  } catch (error) {
    console.error("Error adding caregiver:", error);
    res.status(500).json({
      success: false,
      message: "Server error while adding caregiver",
      error: error.message,
    });
  }
});

// Update a caregiver
router.put("/:id", async (req, res) => {
  const { phoneNumber, caregiver: updatedData } = req.body;
  const caregiverId = req.params.id;

  try {
    const user = await User.findOne({ phoneNumber });
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    // Find caregiver to update
    const caregiver = user.caregivers.id(caregiverId);
    if (!caregiver) {
      return res.status(404).json({
        success: false,
        message: "Caregiver not found",
      });
    }

    // Update caregiver fields
    caregiver.name = updatedData.name;
    caregiver.phoneNumber = updatedData.phoneNumber;
    caregiver.forPersons = updatedData.forPersons;
    caregiver.notificationsEnabled = updatedData.notificationsEnabled;

    await user.save();

    res.status(200).json({
      success: true,
      message: "Caregiver updated successfully",
      caregiver,
    });
  } catch (error) {
    console.error("Error updating caregiver:", error);
    res.status(500).json({
      success: false,
      message: "Server error while updating caregiver",
      error: error.message,
    });
  }
});

// Delete a caregiver
router.delete("/:id", async (req, res) => {
  const { phoneNumber } = req.body;
  const caregiverId = req.params.id;

  try {
    const user = await User.findOne({ phoneNumber });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // Check if caregiver exists
    const caregiverExists = user.caregivers.some((c) =>
      c._id.equals(caregiverId)
    );
    if (!caregiverExists) {
      return res.status(404).json({
        success: false,
        message: "Caregiver not found",
      });
    }

    // CORRECTED: Remove caregiver using pull()
    user.caregivers.pull(caregiverId); // Method 1
    // Alternative: user.caregivers.id(caregiverId).remove(); // Method 2

    await user.save();

    res.status(200).json({
      success: true,
      message: "Caregiver removed successfully",
    });
  } catch (error) {
    console.error("Error deleting caregiver:", error);
    res.status(500).json({
      success: false,
      message: "Server error while deleting caregiver",
      error: error.message,
    });
  }
});

export default router;
