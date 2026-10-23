import { z } from "zod";
export const clinicalFeaturesSchema = z.object({
    Age: z.number(),
    Gender: z.number(),
    dioptre_1: z.number(),
    dioptre_2: z.number(),
    astigmatism: z.number(),
    "Phakic/Pseudophakic": z.number().optional(),
    Phakic_Pseudophakic: z.number().optional(),
    Pneumatic: z.number(),
    Perkins: z.number(),
    Pachymetry: z.number(),
    Axial_Length: z.number(),
    VF_DM: z.number(),
}).transform((data) => ({
    ...data,
    "Phakic/Pseudophakic": data["Phakic/Pseudophakic"] ?? data.Phakic_Pseudophakic ?? 0,
    Phakic_Pseudophakic: data.Phakic_Pseudophakic ?? data["Phakic/Pseudophakic"] ?? 0,
}));
//# sourceMappingURL=clinical.js.map