import mongoose from "mongoose";

const prescriptionSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  timesToTake: {
    type: Number,
    required: true,
    min: 1,
    max: 10,
  },
  dosage: {
    type: Number,
    required: true,
    min: 1,
  },
  instructions: {
    type: String,
    default: "",
  },
  initialCount: {
    type: Number,
    required: true,
    min: 1,
  },
  sideEffects: {
    type: String,
    default: "",
  },
});

const pharmacySchema = new mongoose.Schema({
  firstName: {
    type: String,
    required: true,
    trim: true,
  },
  lastName: {
    type: String,
    required: true,
    trim: true,
  },
  phoneNumber: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    validate: {
      validator: function (v) {
        return /^\d{10,15}$/.test(v);
      },
      message: (props) => `${props.value} is not a valid phone number!`,
    },
  },
  prescriptions: [prescriptionSchema],
  description: {
    type: String,
    required: true,
    trim: true,
    maxlength: 500,
  },
  meta: {
    createdAt: {
      type: Date,
      default: Date.now,
    },
    updatedAt: Date,
  },
});

pharmacySchema.pre("save", function (next) {
  this.meta.updatedAt = Date.now();
  next();
});

const Pharmacy = mongoose.model("Pharmacy", pharmacySchema);
export default Pharmacy;
