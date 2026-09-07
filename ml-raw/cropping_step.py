import cv2
import numpy as np
import os
import glob

def setup_directories(base_dir):
    """Crea las carpetas finales dentro del directorio base si no existen."""
    img_out = os.path.join(base_dir, 'image_cropped')
    mask_out = os.path.join(base_dir, 'mask_cropped')
    os.makedirs(img_out, exist_ok=True)
    os.makedirs(mask_out, exist_ok=True)
    return img_out, mask_out

def crop_optic_disc(img_path, mask_path, out_img_dir, out_mask_dir, crop_size=512):
    # 1. Leer imágenes
    img = cv2.imread(img_path)
    mask = cv2.imread(mask_path, cv2.IMREAD_GRAYSCALE)
    
    if img is None or mask is None:
        print(f"❌ Error cargando {img_path} o su máscara.")
        return False

    h, w, _ = img.shape
    half_crop = crop_size // 2

    # 2. Convertir a LAB y extraer Luminancia
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
    l_channel, a_channel, b_channel = cv2.split(lab)

    # 3. Desenfoque gaussiano severo
    blurred_l = cv2.GaussianBlur(l_channel, (151, 151), 0)

    # 4. Encontrar el punto más luminoso
    _, _, _, max_loc = cv2.minMaxLoc(blurred_l)
    cx, cy = max_loc

    # 5. Calcular coordenadas de recorte
    x1, y1 = cx - half_crop, cy - half_crop
    x2, y2 = cx + half_crop, cy + half_crop

    # 6. Lógica de Padding
    pad_left = max(0, -x1)
    pad_top = max(0, -y1)
    pad_right = max(0, x2 - w)
    pad_bottom = max(0, y2 - h)

    if pad_left > 0 or pad_top > 0 or pad_right > 0 or pad_bottom > 0:
        img = cv2.copyMakeBorder(img, pad_top, pad_bottom, pad_left, pad_right, cv2.BORDER_CONSTANT, value=[0, 0, 0])
        mask = cv2.copyMakeBorder(mask, pad_top, pad_bottom, pad_left, pad_right, cv2.BORDER_CONSTANT, value=0)
        
        x1 += pad_left; x2 += pad_left
        y1 += pad_top;  y2 += pad_top

    # 7. Recorte
    img_cropped = img[y1:y2, x1:x2]
    mask_cropped = mask[y1:y2, x1:x2]

    # VALIDACIÓN
    pixels_original = cv2.countNonZero(mask)
    pixels_recortados = cv2.countNonZero(mask_cropped)
    if pixels_original > pixels_recortados:
        print(f"⚠️ Advertencia en {os.path.basename(img_path)}: El recorte truncó parte del disco/copa.")

    # 8. Preprocesamiento (CLAHE)
    lab_cropped = cv2.cvtColor(img_cropped, cv2.COLOR_BGR2LAB)
    l_crop, a_crop, b_crop = cv2.split(lab_cropped)
    
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    l_clahe = clahe.apply(l_crop)
    
    lab_clahe_merged = cv2.merge((l_clahe, a_crop, b_crop))
    img_final = cv2.cvtColor(lab_clahe_merged, cv2.COLOR_LAB2BGR)

    # 9. Guardar
    # Aseguramos que se guarde con el mismo nombre y extensión
    img_name = os.path.basename(img_path)
    mask_name = os.path.basename(mask_path)
    
    cv2.imwrite(os.path.join(out_img_dir, img_name), img_final)
    cv2.imwrite(os.path.join(out_mask_dir, mask_name), mask_cropped)
    
    print(f"✅ Procesada correctamente: {img_name}")
    return True

# ==========================================
# LÓGICA DE EJECUCIÓN (MODIFICADA PARA TU CASO)
# ==========================================

# Definir directorios
output_base_dir = 'cropped'
out_img, out_mask = setup_directories(output_base_dir)

train_images_dirs = [
    'raw_images/REFUGE2/train/images',
    'raw_images/REFUGE2/test/images',
    'raw_images/REFUGE2/val/images'
]

train_masks_dirs = [
    'raw_images/REFUGE2/train/mask',
    'raw_images/REFUGE2/test/mask',
    'raw_images/REFUGE2/val/mask'
]

for images_dir, masks_dir in zip(train_images_dirs, train_masks_dirs):

    # Buscar todas las imágenes en el directorio actual
    image_files = sorted(glob.glob(os.path.join(images_dir, '*.*')))
    images_to_process = image_files  # o [:5] si quieres limitar

    print(f"📂 Procesando {len(images_to_process)} imágenes de {images_dir}")

    for img_path in images_to_process:
        base_name = os.path.splitext(os.path.basename(img_path))[0]

        # Buscar máscara correspondiente
        mask_search_pattern = os.path.join(masks_dir, f"{base_name}.*")
        matching_masks = glob.glob(mask_search_pattern)

        if not matching_masks:
            print(f"❌ No se encontró máscara para: {base_name}")
            continue

        mask_path = matching_masks[0]

        # Procesar
        crop_optic_disc(img_path, mask_path, out_img, out_mask)

print("\n🎉 Proceso completo. Revisa tu carpeta 'cropped'.")