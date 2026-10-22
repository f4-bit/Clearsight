import { BilateralStudy } from "@/types/clinical";

export const MOCK_STUDY: BilateralStudy = {
  consultation_id: "c48f2a1b-93d2-4e89-a5c3-198f2b7a4e01",
  patient_id: "9b3c7e14-6a2f-4d81-b0c7-58e1f2a9d364",
  doctor_id: "d19e4a3b-28f0-4a7b-8911-39bc17f8a923",
  doctor_name: "Dr. Arismendi",
  created_at: "2026-10-14T16:42:10Z",
  status: "COMPLETED",
  consensus_label: "Suspicious_Glaucoma",
  consensus_confidence: 0.742,
  asymmetry_vcdr: 0.23,
  clinical_features: {
    Age: 63.0,
    Gender: 1.0, // Masculino
    Pneumatic: 23.5, // OD elevada
    Perkins: 22.0, // OD elevada
    Pachymetry: 512.0, // Córnea delgada
    VF_DM: -4.8, // Escotoma
    Axial_Length: 24.8,
    Phakic_Pseudophakic: 1.0, // Fáquico
    dioptre_1: 1.25,
    dioptre_2: -0.75,
    astigmatism: 85.0,
  },
  od: {
    inference_id: "inf-od-8912-38192a",
    eye_side: "OD",
    label: "Suspicious_Glaucoma",
    confidence: 0.742,
    probabilities: {
      Suspicious_Glaucoma: 0.742,
      Glaucoma: 0.184,
      Non_Glaucoma: 0.074,
    },
    model_predictions: {
      resnet50: {
        probabilities: {
          Suspicious_Glaucoma: 0.72,
          Glaucoma: 0.192,
          Non_Glaucoma: 0.088,
        },
        predicted_class: "Suspicious_Glaucoma",
        confidence: 0.72,
      },
      efficientnet_b3: {
        probabilities: {
          Suspicious_Glaucoma: 0.764,
          Glaucoma: 0.176,
          Non_Glaucoma: 0.06,
        },
        predicted_class: "Suspicious_Glaucoma",
        confidence: 0.764,
      },
    },
    cdr: 0.58,
    cdr_vertical: 0.64,
    calipers: {
      cup_height_mm: 1.62,
      disc_height_mm: 2.53,
    },
    quality: {
      disc_detected: true,
      cup_detected: true,
      disc_area: 21400.0,
      cup_area: 7200.0,
      cdr_is_finite: true,
      cdr_in_range: true,
      cup_area_not_larger_than_disc: true,
      review_required: false,
    },
    artifacts: {
      raw_image_url: "/mock/od_raw.jpg",
      mask_url: "/mock/od_mask.png",
      gradcam_url: "/mock/od_gradcam.png",
    },
    model_versions: {
      segmentation: "FPN-ResNet18-v1.0",
      resnet50: "Fold4-v2.1",
      efficientnet_b3: "Fold4-v2.1",
    },
    elapsed_seconds: 1.84,
  },
  os: {
    inference_id: "inf-os-8912-38192b",
    eye_side: "OS",
    label: "Non_Glaucoma",
    confidence: 0.885,
    probabilities: {
      Non_Glaucoma: 0.885,
      Suspicious_Glaucoma: 0.082,
      Glaucoma: 0.033,
    },
    model_predictions: {
      resnet50: {
        probabilities: {
          Non_Glaucoma: 0.87,
          Suspicious_Glaucoma: 0.095,
          Glaucoma: 0.035,
        },
        predicted_class: "Non_Glaucoma",
        confidence: 0.87,
      },
      efficientnet_b3: {
        probabilities: {
          Non_Glaucoma: 0.9,
          Suspicious_Glaucoma: 0.069,
          Glaucoma: 0.031,
        },
        predicted_class: "Non_Glaucoma",
        confidence: 0.9,
      },
    },
    cdr: 0.38,
    cdr_vertical: 0.41,
    calipers: {
      cup_height_mm: 0.98,
      disc_height_mm: 2.4,
    },
    quality: {
      disc_detected: true,
      cup_detected: true,
      disc_area: 21000.0,
      cup_area: 3030.0,
      cdr_is_finite: true,
      cdr_in_range: true,
      cup_area_not_larger_than_disc: true,
      review_required: false,
    },
    artifacts: {
      raw_image_url: "/mock/os_raw.jpg",
      mask_url: "/mock/os_mask.png",
      gradcam_url: "/mock/os_gradcam.png",
    },
    model_versions: {
      segmentation: "FPN-ResNet18-v1.0",
      resnet50: "Fold4-v2.1",
      efficientnet_b3: "Fold4-v2.1",
    },
    elapsed_seconds: 1.76,
  },
};
