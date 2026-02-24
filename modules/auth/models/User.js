import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    displayName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 64,
    },
    passwordHash: {
      type: String,
      required: true,
      select: false,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

userSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: this._id.toString(),
    email: this.email,
    displayName: this.displayName,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

const User = mongoose.models.User || mongoose.model("User", userSchema);

export default User;
