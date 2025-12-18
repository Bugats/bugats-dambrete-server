import express from "express";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import cors from "cors";

// MongoDB lietotāja modelis
const User = mongoose.model("User", {
  nickname: String,
  password: String,
});

const app = express();
const PORT = process.env.PORT || 10080;
app.use(cors());
app.use(express.json()); // lai varētu lasīt POST ķermeņus

// Reģistrēšanās funkcija (sign-up)
app.post("/signup", async (req, res) => {
  const { nickname, password } = req.body;
  
  // Pārbaudām, vai lietotājs jau eksistē
  const existingUser = await User.findOne({ nickname });
  if (existingUser) {
    return res.status(400).send("Lietotājs jau eksistē!");
  }

  // Sifresējam paroli
  const hashedPassword = await bcrypt.hash(password, 10);

  const newUser = new User({
    nickname,
    password: hashedPassword,
  });

  await newUser.save();
  res.status(201).send("Lietotājs izveidots veiksmīgi!");
});

// Pierakstīšanās funkcija (sign-in)
app.post("/signin", async (req, res) => {
  const { nickname, password } = req.body;
  const user = await User.findOne({ nickname });

  if (!user) {
    return res.status(400).send("Nepareizi akreditācijas dati!");
  }

  // Salīdzinām paroli
  const isPasswordValid = await bcrypt.compare(password, user.password);
  if (!isPasswordValid) {
    return res.status(400).send("Nepareizi akreditācijas dati!");
  }

  const token = jwt.sign({ userId: user._id }, "your-secret-key");
  res.status(200).json({ token });
});

// MongoDB savienojums
mongoose.connect("mongodb://localhost/dambretes", { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => app.listen(PORT, () => console.log(`Serveris darbojas uz porta ${PORT}`)));
